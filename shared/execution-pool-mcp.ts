import {
  buildSupervisionExecutionCapabilityId,
  normalizeSupervisionExecutionModel,
  SUPERVISION_EXECUTION_POOL_ROLES,
  type SupervisionExecutionConfig,
  type SupervisionExecutionPoolRole,
} from './supervision-execution-pool.js';
import { getSessionRuntimeType } from './agent-types.js';
import { resolvePeerAuditProviderFamily } from './peer-audit.js';
import { normalizeSharedContextRuntimeBackend } from './shared-context-runtime-config.js';

export const EXECUTION_POOL_MCP_TOOLS = {
  GET: 'execution_pool_get',
  SET: 'execution_pool_set',
} as const;
export type ExecutionPoolMcpToolName = typeof EXECUTION_POOL_MCP_TOOLS[keyof typeof EXECUTION_POOL_MCP_TOOLS];
export const EXECUTION_POOL_MCP_ROLES = SUPERVISION_EXECUTION_POOL_ROLES;
export type ExecutionPoolMcpRole = SupervisionExecutionPoolRole;
export const EXECUTION_POOL_MCP_LIMITS = Object.freeze({ MAX_CONCURRENCY: 100 });

export interface ExecutionPoolMcpEntry {
  model: string;
  provider: string;
  role: ExecutionPoolMcpRole;
  enabled: boolean;
}

export interface ExecutionPoolMcpPatch {
  entries?: ExecutionPoolMcpEntry[];
  pool?: 'primary' | 'economy';
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
  const agentType = normalizeSharedContextRuntimeBackend(rawProvider)
    ?? ({ anthropic: 'claude-code-sdk', openai: 'codex', google: 'gemini', qwen: 'qwen', deepseek: 'deepseek' } as Record<string, string>)[rawProvider.toLowerCase()]
    ?? rawProvider;
  const model = normalizeSupervisionExecutionModel(agentType, entry.model.trim());
  const providerFamily = resolvePeerAuditProviderFamily({ agentType });
  const runtimeType = getSessionRuntimeType(agentType);
  const base = { agentType, providerFamily, runtimeType, model,
    ...(entry.role !== 'both' ? { role: entry.role } : {}) };
  return { ...base, capabilityId: buildSupervisionExecutionCapabilityId(base) };
}

export function validateExecutionPoolMcpPatch(input: unknown): ExecutionPoolMcpPatch | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'input must be an object' };
  const value = input as Record<string, unknown>;
  const patch: ExecutionPoolMcpPatch = {};
  if (value.entries !== undefined) {
    if (!Array.isArray(value.entries)) return { error: 'entries must be an array' };
    const entries: ExecutionPoolMcpEntry[] = [];
    for (const raw of value.entries) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'each entry must be an object' };
      const item = raw as Record<string, unknown>;
      if (typeof item.model !== 'string' || !item.model.trim() || typeof item.provider !== 'string' || !item.provider.trim()) {
        return { error: 'each entry requires model and provider' };
      }
      const role = item.role === undefined ? 'both' : item.role;
      if (!EXECUTION_POOL_MCP_ROLES.includes(role as ExecutionPoolMcpRole)) return { error: `invalid role: ${String(role)}` };
      if (item.enabled !== undefined && typeof item.enabled !== 'boolean') return { error: 'enabled must be boolean' };
      entries.push({ model: item.model.trim(), provider: item.provider.trim(), role: role as ExecutionPoolMcpRole, enabled: item.enabled !== false });
    }
    patch.entries = entries;
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
