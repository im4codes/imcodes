/**
 * The official MCP Registry (registry.modelcontextprotocol.io), searched for
 * the MCP tab. Only what an install form needs is kept -- a remote endpoint or
 * an npm package, and the headers or variables it asks for -- and all of it is
 * re-validated: it is text from the internet.
 */
import {
  AGENT_MCP_REGISTRY,
  AGENT_MCP_TRANSPORT,
  type AgentMcpRegistryInput,
  type AgentMcpRegistryServer,
} from '../../../shared/agent-mcp.js';
import { getJsonWithin, processFetch, TtlCache, type Fetch } from './cached-json-fetch.js';

const SEARCH_CACHE_MS = 5 * 60_000;
const TEXT_CHARS = 400;
const INPUT_NAME = /^[A-Za-z0-9_.!#$%&'*+^`|~-]{1,128}$/u;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const VERSION = /^[A-Za-z0-9._+-]{1,64}$/u;

function text(value: unknown, max = TEXT_CHARS): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max)
    : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function inputs(value: unknown): AgentMcpRegistryInput[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((raw): AgentMcpRegistryInput[] => {
    const record = raw as Record<string, unknown> | null;
    const name = record?.name;
    if (typeof name !== 'string' || !INPUT_NAME.test(name)) return [];
    const description = text(record?.description);
    const template = text(record?.value, 200);
    return [{
      name,
      ...(description ? { description } : {}),
      required: record?.isRequired === true,
      secret: record?.isSecret === true,
      ...(template ? { template } : {}),
    }];
  });
}

function readServer(raw: unknown): AgentMcpRegistryServer | null {
  const entry = raw as { server?: Record<string, unknown>; _meta?: Record<string, unknown> } | null;
  const server = entry?.server;
  const id = text(server?.name, 200);
  if (!server || !id) return null;
  const official = entry?._meta?.['io.modelcontextprotocol.registry/official'] as Record<string, unknown> | undefined;
  if (official && official.status !== undefined && official.status !== 'active') return null;

  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  let remote: AgentMcpRegistryServer['remote'];
  for (const candidate of remotes as Array<Record<string, unknown>>) {
    const url = httpsUrl(candidate?.url);
    const transport = candidate?.type === 'sse' ? AGENT_MCP_TRANSPORT.SSE
      : candidate?.type === 'streamable-http' || candidate?.type === 'http' ? AGENT_MCP_TRANSPORT.HTTP : undefined;
    if (url && transport) {
      remote = { transport, url, headers: inputs(candidate.headers) };
      break;
    }
  }

  const packages = Array.isArray(server.packages) ? server.packages : [];
  let npm: AgentMcpRegistryServer['npm'];
  for (const candidate of packages as Array<Record<string, unknown>>) {
    const identifier = candidate?.identifier;
    const transport = (candidate?.transport as Record<string, unknown> | undefined)?.type;
    if (candidate?.registryType === 'npm' && transport === 'stdio'
      && typeof identifier === 'string' && NPM_PACKAGE.test(identifier)) {
      const version = typeof candidate.version === 'string' && VERSION.test(candidate.version) ? candidate.version : undefined;
      npm = { identifier, ...(version ? { version } : {}), env: inputs(candidate.environmentVariables) };
      break;
    }
  }
  if (!remote && !npm) return null;

  const version = typeof server.version === 'string' && VERSION.test(server.version) ? server.version : undefined;
  const repositoryUrl = httpsUrl((server.repository as Record<string, unknown> | undefined)?.url);
  return {
    id,
    description: text(server.description) ?? '',
    ...(version ? { version } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(remote ? { remote } : {}),
    ...(npm ? { npm } : {}),
  };
}

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
      const servers = (body as { servers?: unknown } | null)?.servers;
      if (!Array.isArray(servers)) throw new Error('registry_shape');
      const results = servers.map(readServer).filter((server): server is AgentMcpRegistryServer => server !== null);
      searches.set(key, results, now());
      return results;
    },
  };
}
