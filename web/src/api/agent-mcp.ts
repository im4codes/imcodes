import { apiFetch, ApiError } from '../api.js';
import {
  AGENT_MCP_ERROR,
  type AgentMcpList,
  type AgentMcpRegistryServer,
  type AgentMcpRunRequest,
  type AgentMcpRunResult,
} from '@shared/agent-mcp.js';

/** The MCP servers in one machine's agent configs, and the agents found there. */
export async function listAgentMcp(serverId: string): Promise<AgentMcpList> {
  const response = await apiFetch<Partial<AgentMcpList>>(`/api/agent-mcp?serverId=${encodeURIComponent(serverId)}`);
  return {
    servers: Array.isArray(response.servers) ? response.servers : [],
    agents: Array.isArray(response.agents) ? response.agents : [],
  };
}

/**
 * Add or remove one server on one machine. A refusal or failure comes back as
 * a result rather than a throw, so installing on several machines can report
 * each one.
 */
export async function runAgentMcp(serverId: string, request: AgentMcpRunRequest): Promise<AgentMcpRunResult | { ok: false; error: string }> {
  try {
    return await apiFetch<AgentMcpRunResult>(`/api/agent-mcp/run?serverId=${encodeURIComponent(serverId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (error) {
    return { ok: false, error: error instanceof ApiError && error.code ? error.code : AGENT_MCP_ERROR.DAEMON_OFFLINE };
  }
}

/** Search the official MCP Registry; throws when it is unavailable. */
export async function searchAgentMcpRegistry(query: string): Promise<AgentMcpRegistryServer[]> {
  const response = await apiFetch<{ results?: AgentMcpRegistryServer[] }>(
    `/api/agent-mcp/registry/search?q=${encodeURIComponent(query)}`,
  );
  return Array.isArray(response.results) ? response.results : [];
}
