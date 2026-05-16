import { PROVIDER_STATUS_REASON } from './provider-status-reasons.js';
import { MCP_ERROR_REASONS } from './memory-mcp-errors.js';

export const MEMORY_WS = {
  SEARCH: 'memory.search',
  SEARCH_RESPONSE: 'memory.search_response',
  ARCHIVE: 'memory.archive',
  ARCHIVE_RESPONSE: 'memory.archive_response',
  RESTORE: 'memory.restore',
  RESTORE_RESPONSE: 'memory.restore_response',
  CREATE: 'memory.create',
  CREATE_RESPONSE: 'memory.create_response',
  UPDATE: 'memory.update',
  UPDATE_RESPONSE: 'memory.update_response',
  PIN: 'memory.pin',
  PIN_RESPONSE: 'memory.pin_response',
  DELETE: 'memory.delete',
  DELETE_RESPONSE: 'memory.delete_response',
  PERSONAL_QUERY: 'shared_context.personal_memory.query',
  PERSONAL_RESPONSE: 'shared_context.personal_memory.response',
  PROJECT_RESOLVE: 'memory.project.resolve',
  PROJECT_RESOLVE_RESPONSE: 'memory.project.resolve_response',
  FEATURES_QUERY: 'memory.features.query',
  FEATURES_RESPONSE: 'memory.features.response',
  FEATURES_SET: 'memory.features.set',
  FEATURES_SET_RESPONSE: 'memory.features.set_response',
  PREF_QUERY: 'memory.preferences.query',
  PREF_RESPONSE: 'memory.preferences.response',
  PREF_CREATE: 'memory.preferences.create',
  PREF_CREATE_RESPONSE: 'memory.preferences.create_response',
  PREF_UPDATE: 'memory.preferences.update',
  PREF_UPDATE_RESPONSE: 'memory.preferences.update_response',
  PREF_DELETE: 'memory.preferences.delete',
  PREF_DELETE_RESPONSE: 'memory.preferences.delete_response',
  SKILL_QUERY: 'memory.skills.query',
  SKILL_RESPONSE: 'memory.skills.response',
  SKILL_REBUILD: 'memory.skills.rebuild',
  SKILL_REBUILD_RESPONSE: 'memory.skills.rebuild_response',
  SKILL_READ: 'memory.skills.read',
  SKILL_READ_RESPONSE: 'memory.skills.read_response',
  SKILL_DELETE: 'memory.skills.delete',
  SKILL_DELETE_RESPONSE: 'memory.skills.delete_response',
  MD_INGEST_RUN: 'memory.md_ingest.run',
  MD_INGEST_RUN_RESPONSE: 'memory.md_ingest.run_response',
  OBSERVATION_QUERY: 'memory.observations.query',
  OBSERVATION_RESPONSE: 'memory.observations.response',
  OBSERVATION_UPDATE: 'memory.observations.update',
  OBSERVATION_UPDATE_RESPONSE: 'memory.observations.update_response',
  OBSERVATION_DELETE: 'memory.observations.delete',
  OBSERVATION_DELETE_RESPONSE: 'memory.observations.delete_response',
  OBSERVATION_PROMOTE: 'memory.observations.promote',
  OBSERVATION_PROMOTE_RESPONSE: 'memory.observations.promote_response',
  MCP_STATUS_QUERY: 'memory.mcp_status.query',
  MCP_STATUS_RESPONSE: 'memory.mcp_status.response',
} as const;

export type MemoryWsType = typeof MEMORY_WS[keyof typeof MEMORY_WS];

export const MEMORY_MCP_PROVIDER_ID = {
  CLAUDE_CODE_SDK: 'claude-code-sdk',
  GEMINI_SDK: 'gemini-sdk',
  COPILOT_SDK: 'copilot-sdk',
  CODEX_SDK: 'codex-sdk',
  CURSOR_HEADLESS: 'cursor-headless',
  QWEN: 'qwen',
} as const;

export const MEMORY_MCP_PROVIDER_IDS = [
  MEMORY_MCP_PROVIDER_ID.CLAUDE_CODE_SDK,
  MEMORY_MCP_PROVIDER_ID.GEMINI_SDK,
  MEMORY_MCP_PROVIDER_ID.COPILOT_SDK,
  MEMORY_MCP_PROVIDER_ID.CODEX_SDK,
  MEMORY_MCP_PROVIDER_ID.CURSOR_HEADLESS,
  MEMORY_MCP_PROVIDER_ID.QWEN,
] as const;

export type MemoryMcpProviderId = (typeof MEMORY_MCP_PROVIDER_IDS)[number];

export const MEMORY_MCP_TOOL_FAMILY = {
  MEMORY: 'memory',
  SEND: 'send',
  CRON: 'cron',
} as const;

export const MEMORY_MCP_TOOL_FAMILIES = [
  MEMORY_MCP_TOOL_FAMILY.MEMORY,
  MEMORY_MCP_TOOL_FAMILY.SEND,
  MEMORY_MCP_TOOL_FAMILY.CRON,
] as const;

export type MemoryMcpToolFamily = (typeof MEMORY_MCP_TOOL_FAMILIES)[number];

export const MEMORY_MCP_STATUS = {
  READY: 'ready',
  DEGRADED: 'degraded',
  DISABLED: 'disabled',
  UNKNOWN: 'unknown',
} as const;

export const MEMORY_MCP_STATUS_VALUES = [
  MEMORY_MCP_STATUS.READY,
  MEMORY_MCP_STATUS.DEGRADED,
  MEMORY_MCP_STATUS.DISABLED,
  MEMORY_MCP_STATUS.UNKNOWN,
] as const;

export type MemoryMcpStatusValue = (typeof MEMORY_MCP_STATUS_VALUES)[number];

export const MEMORY_MCP_PROVIDER_STATUS_REASON = {
  PROVIDER_NOT_CONNECTED: PROVIDER_STATUS_REASON.PROVIDER_NOT_CONNECTED,
  MCP_REGISTRATION_FAILED: 'mcp_registration_failed',
} as const;

export type MemoryMcpProviderStatusReason =
  (typeof MEMORY_MCP_PROVIDER_STATUS_REASON)[keyof typeof MEMORY_MCP_PROVIDER_STATUS_REASON];

export const MEMORY_MCP_DEGRADED_REASON = {
  ...MEMORY_MCP_PROVIDER_STATUS_REASON,
  ENV_FORWARDING_UNVERIFIED: 'env_forwarding_unverified',
  FEATURE_DISABLED: MCP_ERROR_REASONS.FEATURE_DISABLED,
  STATUS_NOT_REPORTED: 'status_not_reported',
} as const;

export type MemoryMcpDegradedReason =
  (typeof MEMORY_MCP_DEGRADED_REASON)[keyof typeof MEMORY_MCP_DEGRADED_REASON];

export interface MemoryMcpProviderStatusView {
  providerId: MemoryMcpProviderId | string;
  status: MemoryMcpStatusValue;
  connected?: boolean | null;
  degradedReasons?: string[];
}

export interface MemoryMcpToolFamilyGateView {
  family: MemoryMcpToolFamily;
  status?: MemoryMcpStatusValue;
  enabled?: boolean | null;
  disabledFlag?: string;
  degradedReasons?: string[];
  tools?: string[];
}

export interface MemoryMcpRecentCallView {
  id: string;
  providerId?: MemoryMcpProviderId | string;
  toolName: string;
  family?: MemoryMcpToolFamily;
  status: string;
  occurredAt?: number;
  durationMs?: number;
  redactedInput?: string;
  redactedResult?: string;
  errorReason?: string;
}

export interface MemoryMcpStatusResponseMessage {
  type: typeof MEMORY_WS.MCP_STATUS_RESPONSE;
  requestId?: string;
  providers?: MemoryMcpProviderStatusView[];
  toolFamilies?: MemoryMcpToolFamilyGateView[];
  recentCalls?: MemoryMcpRecentCallView[];
  updatedAt?: number;
  error?: string;
}

export const MEMORY_MANAGEMENT_REQUEST_TYPES = [
  MEMORY_WS.SEARCH,
  MEMORY_WS.ARCHIVE,
  MEMORY_WS.RESTORE,
  MEMORY_WS.CREATE,
  MEMORY_WS.UPDATE,
  MEMORY_WS.PIN,
  MEMORY_WS.DELETE,
  MEMORY_WS.PERSONAL_QUERY,
  MEMORY_WS.PROJECT_RESOLVE,
  MEMORY_WS.FEATURES_QUERY,
  MEMORY_WS.FEATURES_SET,
  MEMORY_WS.PREF_QUERY,
  MEMORY_WS.PREF_CREATE,
  MEMORY_WS.PREF_UPDATE,
  MEMORY_WS.PREF_DELETE,
  MEMORY_WS.SKILL_QUERY,
  MEMORY_WS.SKILL_REBUILD,
  MEMORY_WS.SKILL_READ,
  MEMORY_WS.SKILL_DELETE,
  MEMORY_WS.MD_INGEST_RUN,
  MEMORY_WS.OBSERVATION_QUERY,
  MEMORY_WS.OBSERVATION_UPDATE,
  MEMORY_WS.OBSERVATION_DELETE,
  MEMORY_WS.OBSERVATION_PROMOTE,
  MEMORY_WS.MCP_STATUS_QUERY,
] as const satisfies readonly MemoryWsType[];

export const MEMORY_MANAGEMENT_RESPONSE_TYPES = [
  MEMORY_WS.ARCHIVE_RESPONSE,
  MEMORY_WS.RESTORE_RESPONSE,
  MEMORY_WS.CREATE_RESPONSE,
  MEMORY_WS.UPDATE_RESPONSE,
  MEMORY_WS.PIN_RESPONSE,
  MEMORY_WS.DELETE_RESPONSE,
  MEMORY_WS.PERSONAL_RESPONSE,
  MEMORY_WS.PROJECT_RESOLVE_RESPONSE,
  MEMORY_WS.FEATURES_RESPONSE,
  MEMORY_WS.FEATURES_SET_RESPONSE,
  MEMORY_WS.PREF_RESPONSE,
  MEMORY_WS.PREF_CREATE_RESPONSE,
  MEMORY_WS.PREF_UPDATE_RESPONSE,
  MEMORY_WS.PREF_DELETE_RESPONSE,
  MEMORY_WS.SKILL_RESPONSE,
  MEMORY_WS.SKILL_REBUILD_RESPONSE,
  MEMORY_WS.SKILL_READ_RESPONSE,
  MEMORY_WS.SKILL_DELETE_RESPONSE,
  MEMORY_WS.MD_INGEST_RUN_RESPONSE,
  MEMORY_WS.OBSERVATION_RESPONSE,
  MEMORY_WS.OBSERVATION_UPDATE_RESPONSE,
  MEMORY_WS.OBSERVATION_DELETE_RESPONSE,
  MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE,
  MEMORY_WS.SEARCH_RESPONSE,
  MEMORY_WS.MCP_STATUS_RESPONSE,
] as const;

const MEMORY_MANAGEMENT_REQUEST_TYPE_SET: ReadonlySet<string> = new Set(MEMORY_MANAGEMENT_REQUEST_TYPES);
const MEMORY_MANAGEMENT_RESPONSE_TYPE_SET: ReadonlySet<string> = new Set(MEMORY_MANAGEMENT_RESPONSE_TYPES);

export function isMemoryManagementRequestType(type: unknown): type is (typeof MEMORY_MANAGEMENT_REQUEST_TYPES)[number] {
  return typeof type === 'string' && MEMORY_MANAGEMENT_REQUEST_TYPE_SET.has(type);
}

export function isMemoryManagementResponseType(type: unknown): type is (typeof MEMORY_MANAGEMENT_RESPONSE_TYPES)[number] {
  return typeof type === 'string' && MEMORY_MANAGEMENT_RESPONSE_TYPE_SET.has(type);
}
