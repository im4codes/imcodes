import * as addMcp from 'add-mcp';
import {
  AGENT_MCP_ACTION,
  AGENT_MCP_ERROR,
  AGENT_MCP_LIMITS,
  AGENT_MCP_MSG,
  AGENT_MCP_TRANSPORT,
  isReservedAgentMcpName,
  readAgentMcpRunRequest,
  type AgentMcpAgent,
  type AgentMcpAgentResult,
  type AgentMcpList,
  type AgentMcpRunRequest,
  type AgentMcpRunResult,
  type AgentMcpServerEntry,
  type AgentMcpServerSpec,
  type AgentMcpTransport,
} from '../../shared/agent-mcp.js';

/**
 * MCP servers in each agent's own config on this machine, through the add-mcp
 * SDK: it knows where every agent keeps its servers and in which shape (JSON,
 * TOML, YAML), so a server added here is one that agent really loads -- a
 * Claude or Codex session IM.codes starts included.
 */

/** The part of the add-mcp SDK used here; tests pass their own. */
export interface AgentMcpSdk {
  detectGlobalAgents(): Promise<string[]>;
  listInstalledServers(options: { global?: boolean }): Promise<Array<{
    agentType: string;
    displayName: string;
    detected: boolean;
    servers: Array<{ serverName: string; config: Record<string, unknown>; identity: string }>;
    error?: string;
  }>>;
  upsertServer(agent: string, name: string, config: Record<string, unknown>, options?: { local?: boolean }): {
    success: boolean; error?: string; droppedFields?: string[];
  };
  removeServer(agent: string, name: string, options?: { local?: boolean }): { success: boolean; removed: boolean; error?: string };
  agents: Record<string, { displayName: string; supportedTransports: string[] }>;
}

const defaultSdk = addMcp as unknown as AgentMcpSdk;

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function namesOf(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).slice(0, AGENT_MCP_LIMITS.ENTRIES).sort()
    : [];
}

/** A URL fit to show: no credentials, no query string (tokens often ride there). */
function displayUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

/** The package a local server runs (`npx -y @scope/pkg ...` → `@scope/pkg`), when it can be told. */
function packageOf(command: string, args: string[]): string | undefined {
  const runner = command.replace(/\.(cmd|exe)$/iu, '').split(/[\\/]/u).pop() ?? '';
  if (!['npx', 'bunx', 'uvx', 'pnpx', 'pipx'].includes(runner)) return undefined;
  return args.find((arg) => !arg.startsWith('-'));
}

/**
 * One agent's native server entry, reduced to what may be shown: transport,
 * URL or command and package, and the NAMES of its variables and headers.
 * Argument lists are not shown -- connection strings and tokens live there.
 */
export function describeAgentMcpConfig(name: string, config: Record<string, unknown>): Omit<AgentMcpServerEntry, 'agents'> {
  const rawUrl = stringOf(config.url) ?? stringOf(config.httpUrl) ?? stringOf(config.serverUrl) ?? stringOf(config.uri);
  const envNames = namesOf(config.env ?? config.environment);
  const headerNames = namesOf(config.headers ?? config.http_headers);
  if (rawUrl) {
    const declared = `${stringOf(config.type) ?? stringOf(config.transport) ?? ''}`.toLowerCase();
    const transport: AgentMcpTransport = declared === 'sse' ? AGENT_MCP_TRANSPORT.SSE : AGENT_MCP_TRANSPORT.HTTP;
    const url = displayUrl(rawUrl);
    return { name, transport, ...(url ? { url } : {}), envNames, headerNames };
  }
  const commandLine = Array.isArray(config.command) ? config.command.filter((part): part is string => typeof part === 'string') : [];
  const command = commandLine[0] ?? stringOf(config.command) ?? stringOf(config.cmd);
  const args = [
    ...commandLine.slice(1),
    ...(Array.isArray(config.args) ? config.args.filter((part): part is string => typeof part === 'string') : []),
  ];
  const packageName = command ? packageOf(command, args) : undefined;
  return {
    name,
    transport: AGENT_MCP_TRANSPORT.STDIO,
    ...(command ? { command: command.split(/[\\/]/u).pop() } : {}),
    ...(packageName ? { packageName } : {}),
    envNames,
    headerNames,
  };
}

/** Every server in every detected agent's global config, one entry per name. */
export async function listAgentMcp(sdk: AgentMcpSdk = defaultSdk): Promise<AgentMcpList> {
  const [installed, detected] = await Promise.all([
    sdk.listInstalledServers({ global: true }),
    sdk.detectGlobalAgents(),
  ]);
  const byName = new Map<string, AgentMcpServerEntry>();
  for (const agent of installed) {
    for (const server of agent.servers) {
      const existing = byName.get(server.serverName);
      if (existing) {
        if (!existing.agents.includes(agent.agentType)) existing.agents.push(agent.agentType);
        continue;
      }
      if (byName.size >= AGENT_MCP_LIMITS.SERVERS) continue;
      byName.set(server.serverName, { ...describeAgentMcpConfig(server.serverName, server.config ?? {}), agents: [agent.agentType] });
    }
  }
  const agents: AgentMcpAgent[] = detected
    .filter((agent) => sdk.agents[agent])
    .map((agent) => ({ agent, displayName: sdk.agents[agent]!.displayName }));
  return {
    servers: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    agents,
  };
}

/** The canonical config add-mcp turns into each agent's own shape. */
function canonicalConfig(server: AgentMcpServerSpec): Record<string, unknown> {
  if (server.transport === AGENT_MCP_TRANSPORT.STDIO) {
    return {
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    };
  }
  return {
    type: server.transport,
    url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
  };
}

/** Add or remove one server on this machine, agent by agent. */
export async function runAgentMcp(
  request: AgentMcpRunRequest,
  sdk: AgentMcpSdk = defaultSdk,
): Promise<AgentMcpRunResult> {
  const results: AgentMcpAgentResult[] = [];
  if (request.action === AGENT_MCP_ACTION.ADD && request.server) {
    const transport = request.server.transport;
    const detected = await sdk.detectGlobalAgents();
    const targets = (request.agents ?? detected)
      .filter((agent) => detected.includes(agent) && sdk.agents[agent]?.supportedTransports.includes(transport));
    if (targets.length === 0) return { ok: false, error: AGENT_MCP_ERROR.NO_AGENTS, list: await listAgentMcp(sdk) };
    const config = canonicalConfig(request.server);
    for (const agent of targets) {
      try {
        const written = sdk.upsertServer(agent, request.server.name, config, { local: false });
        results.push({
          agent,
          ok: written.success,
          ...(written.error ? { error: written.error.slice(0, 300) } : {}),
          ...(written.droppedFields?.length ? { dropped: written.droppedFields } : {}),
        });
      } catch (error) {
        results.push({ agent, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      }
    }
  } else if (request.action === AGENT_MCP_ACTION.REMOVE && request.name) {
    if (isReservedAgentMcpName(request.name)) return { ok: false, error: AGENT_MCP_ERROR.RESERVED_NAME };
    const before = await listAgentMcp(sdk);
    const holders = before.servers.find((server) => server.name === request.name)?.agents ?? [];
    for (const agent of holders.filter((holder) => !request.agents || request.agents.includes(holder))) {
      try {
        const removed = sdk.removeServer(agent, request.name, { local: false });
        results.push({ agent, ok: removed.success, ...(removed.error ? { error: removed.error.slice(0, 300) } : {}) });
      } catch (error) {
        results.push({ agent, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      }
    }
  } else {
    return { ok: false, error: AGENT_MCP_ERROR.INVALID_REQUEST };
  }
  const ok = results.length > 0 && results.every((result) => result.ok);
  return { ok, ...(ok ? {} : { error: AGENT_MCP_ERROR.FAILED }), results, list: await listAgentMcp(sdk) };
}

let running: Promise<unknown> = Promise.resolve();

/**
 * Answer one agent-MCP request from the server, one edit at a time: two writers
 * on the same config file would each keep only their own change. The request
 * comes from a browser the server has already authorised for this machine; it
 * is still validated here before anything is written.
 */
export async function handleAgentMcpCommand(
  cmd: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  sdk: AgentMcpSdk = defaultSdk,
): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' && cmd.requestId.length <= 128 ? cmd.requestId : undefined;
  if (!requestId) return;
  if (cmd.type === AGENT_MCP_MSG.LIST_REQUEST) {
    try {
      send({ type: AGENT_MCP_MSG.LIST_RESPONSE, requestId, ...(await listAgentMcp(sdk)) });
    } catch {
      send({ type: AGENT_MCP_MSG.LIST_RESPONSE, requestId, servers: [], agents: [], error: AGENT_MCP_ERROR.FAILED });
    }
    return;
  }
  if (cmd.type !== AGENT_MCP_MSG.RUN_REQUEST) return;
  const request = readAgentMcpRunRequest(cmd);
  if (!request) {
    send({ type: AGENT_MCP_MSG.RUN_RESPONSE, requestId, ok: false, error: AGENT_MCP_ERROR.INVALID_REQUEST });
    return;
  }
  const turn = running.then(() => runAgentMcp(request, sdk), () => runAgentMcp(request, sdk));
  running = turn.catch(() => undefined);
  try {
    send({ type: AGENT_MCP_MSG.RUN_RESPONSE, requestId, ...(await turn) });
  } catch {
    send({ type: AGENT_MCP_MSG.RUN_RESPONSE, requestId, ok: false, error: AGENT_MCP_ERROR.FAILED });
  }
}
