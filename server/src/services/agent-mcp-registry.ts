/**
 * The official MCP Registry (registry.modelcontextprotocol.io), searched for
 * the MCP tab. Only what an install form needs is kept -- a remote endpoint or
 * an npm package, and the headers or variables it asks for -- and all of it is
 * re-validated: it is text from the internet.
 */
import {
  AGENT_MCP_REGISTRY,
  parseAgentMcpRegistryServers,
  type AgentMcpRegistryServer,
} from '../../../shared/agent-mcp.js';
import { getJsonWithin, processFetch, TtlCache, type Fetch } from './cached-json-fetch.js';

const SEARCH_CACHE_MS = 5 * 60_000;

export function createAgentMcpRegistry(options: { fetchImpl?: Fetch; now?: () => number } = {}) {
  const fetchImpl = options.fetchImpl ?? processFetch;
  const now = options.now ?? Date.now;
  const searches = new TtlCache<AgentMcpRegistryServer[]>(SEARCH_CACHE_MS);
  return {
    /** Installable servers matching `query`. Throws when the registry fails. */
    async search(query: string): Promise<AgentMcpRegistryServer[]> {
      const key = query.toLowerCase();
      const cached = searches.get(key, now());
      if (cached) return cached;
      const params = new URLSearchParams({ search: query, limit: String(AGENT_MCP_REGISTRY.SEARCH_LIMIT), version: 'latest' });
      const body = await getJsonWithin(fetchImpl, `${AGENT_MCP_REGISTRY.SEARCH_URL}?${params.toString()}`, AGENT_MCP_REGISTRY.TIMEOUT_MS);
      const results = parseAgentMcpRegistryServers(body);
      searches.set(key, results, now());
      return results;
    },
  };
}
