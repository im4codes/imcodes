/**
 * MCP servers live in each agent's own config -- ~/.claude.json,
 * ~/.codex/config.toml, ~/.gemini/settings.json, ... -- which the agent reads
 * whether IM.codes started it or not. IM.codes keeps no copy: on each machine
 * the daemon lists and edits those configs through the add-mcp SDK, for every
 * agent it detects there.
 */

import { MACHINE_CONFIG_REQUEST_ERROR } from './machine-config-request.js';

/** Every agent-MCP frame type starts with this. */
export const AGENT_MCP_MESSAGE_PREFIX = 'agent_mcp.' as const;

export const AGENT_MCP_MSG = {
  LIST_REQUEST: `${AGENT_MCP_MESSAGE_PREFIX}list_request`,
  LIST_RESPONSE: `${AGENT_MCP_MESSAGE_PREFIX}list_response`,
  RUN_REQUEST: `${AGENT_MCP_MESSAGE_PREFIX}run_request`,
  RUN_RESPONSE: `${AGENT_MCP_MESSAGE_PREFIX}run_response`,
} as const;

export const AGENT_MCP_ACTION = {
  ADD: 'add',
  REMOVE: 'remove',
} as const;
export type AgentMcpAction = typeof AGENT_MCP_ACTION[keyof typeof AGENT_MCP_ACTION];

export const AGENT_MCP_TRANSPORT = {
  STDIO: 'stdio',
  HTTP: 'http',
  SSE: 'sse',
} as const;
export type AgentMcpTransport = typeof AGENT_MCP_TRANSPORT[keyof typeof AGENT_MCP_TRANSPORT];

export const AGENT_MCP_ERROR = {
  INVALID_REQUEST: 'invalid_request',
  DAEMON_OFFLINE: MACHINE_CONFIG_REQUEST_ERROR.DAEMON_OFFLINE,
  TIMEOUT: MACHINE_CONFIG_REQUEST_ERROR.TIMEOUT,
  /** The name belongs to IM.codes' own MCP server, which is never edited here. */
  RESERVED_NAME: 'reserved_name',
  /** No agent that can take this server was found on the machine. */
  NO_AGENTS: 'no_agents',
  FAILED: 'failed',
} as const;
export type AgentMcpError = typeof AGENT_MCP_ERROR[keyof typeof AGENT_MCP_ERROR];

/** IM.codes' own server, written by the daemon itself; never added or removed here. */
export const AGENT_MCP_RESERVED_NAMES: readonly string[] = ['imcodes-memory'];

export const AGENT_MCP_LIMITS = {
  NAME_CHARS: 64,
  URL_CHARS: 2000,
  COMMAND_CHARS: 200,
  ARGS: 32,
  ARG_CHARS: 1000,
  ENTRIES: 32,
  VALUE_CHARS: 4000,
  SERVERS: 500,
  AGENTS: 32,
} as const;

/** What the daemon reports about one installed server -- never a secret value. */
export interface AgentMcpServerEntry {
  name: string;
  transport: AgentMcpTransport;
  /** Remote servers: the URL without its query string or credentials. */
  url?: string;
  /** Local servers: the command, and the package it runs when it can tell. */
  command?: string;
  packageName?: string;
  /** Names only; the values stay on the machine. */
  envNames: string[];
  headerNames: string[];
  /** The agents whose config has this server. */
  agents: string[];
}

export interface AgentMcpAgent {
  agent: string;
  displayName: string;
}

export interface AgentMcpList {
  servers: AgentMcpServerEntry[];
  /** Agents found on the machine that an install would configure. */
  agents: AgentMcpAgent[];
}

export interface AgentMcpServerSpec {
  name: string;
  transport: AgentMcpTransport;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentMcpRunRequest {
  action: AgentMcpAction;
  /** For add. */
  server?: AgentMcpServerSpec;
  /** For remove. */
  name?: string;
  /** Limit to these agents; every detected agent when absent. */
  agents?: string[];
}

export interface AgentMcpAgentResult {
  agent: string;
  ok: boolean;
  error?: string;
  /** Fields this agent's config cannot express, dropped on write. */
  dropped?: string[];
}

export interface AgentMcpRunResult {
  ok: boolean;
  error?: AgentMcpError;
  results?: AgentMcpAgentResult[];
  list?: AgentMcpList;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const AGENT = /^[a-z0-9][a-z0-9-]{0,40}$/u;
// A program name or an absolute path to one; no shell syntax, no spaces.
const COMMAND = /^(?:[A-Za-z0-9._+-]+|\/[A-Za-z0-9._+\/-]+|[A-Za-z]:\\[A-Za-z0-9._+\\ -]+)$/u;

export function isAgentMcpName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= AGENT_MCP_LIMITS.NAME_CHARS
    && NAME.test(value);
}

export function isReservedAgentMcpName(name: string): boolean {
  return AGENT_MCP_RESERVED_NAMES.includes(name.toLowerCase());
}

function isRemoteUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > AGENT_MCP_LIMITS.URL_CHARS) return false;
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return (url.protocol === 'https:' || (url.protocol === 'http:' && local))
      && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function readMap(value: unknown, keyPattern: RegExp): Record<string, string> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > AGENT_MCP_LIMITS.ENTRIES) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!keyPattern.test(key) || key.length > 128 || typeof raw !== 'string'
      || raw.length > AGENT_MCP_LIMITS.VALUE_CHARS || /[\r\n\0]/u.test(raw)) return null;
    out[key] = raw;
  }
  return out;
}

/** The server to add, validated; null when anything about it is wrong. */
export function readAgentMcpServerSpec(value: unknown): AgentMcpServerSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isAgentMcpName(record.name) || isReservedAgentMcpName(record.name)) return null;
  const transport = Object.values(AGENT_MCP_TRANSPORT).find((candidate) => candidate === record.transport);
  if (!transport) return null;
  if (transport === AGENT_MCP_TRANSPORT.STDIO) {
    if (typeof record.command !== 'string' || record.command.length > AGENT_MCP_LIMITS.COMMAND_CHARS
      || !COMMAND.test(record.command) || record.url !== undefined || record.headers !== undefined) return null;
    const args = record.args === undefined ? [] : record.args;
    if (!Array.isArray(args) || args.length > AGENT_MCP_LIMITS.ARGS
      || !args.every((arg) => typeof arg === 'string' && arg.length <= AGENT_MCP_LIMITS.ARG_CHARS && !/[\r\n\0]/u.test(arg))) return null;
    const env = readMap(record.env, ENV_NAME);
    if (!env) return null;
    return {
      name: record.name,
      transport,
      command: record.command,
      ...(args.length > 0 ? { args: args as string[] } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  if (!isRemoteUrl(record.url) || record.command !== undefined || record.args !== undefined || record.env !== undefined) return null;
  const headers = readMap(record.headers, HEADER_NAME);
  if (!headers) return null;
  return {
    name: record.name,
    transport,
    url: record.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/** The run request, validated; null when anything about it is wrong. */
export function readAgentMcpRunRequest(value: unknown): AgentMcpRunRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const agents = record.agents;
  if (agents !== undefined && (!Array.isArray(agents) || agents.length === 0
    || agents.length > AGENT_MCP_LIMITS.AGENTS || !agents.every((agent) => typeof agent === 'string' && AGENT.test(agent)))) {
    return null;
  }
  const scoped = agents ? { agents: agents as string[] } : {};
  if (record.action === AGENT_MCP_ACTION.ADD) {
    const server = readAgentMcpServerSpec(record.server);
    return server && record.name === undefined ? { action: AGENT_MCP_ACTION.ADD, server, ...scoped } : null;
  }
  if (record.action === AGENT_MCP_ACTION.REMOVE) {
    return isAgentMcpName(record.name) && !isReservedAgentMcpName(record.name) && record.server === undefined
      ? { action: AGENT_MCP_ACTION.REMOVE, name: record.name, ...scoped }
      : null;
  }
  return null;
}

/**
 * The official MCP Registry, searched through the IM.codes server (the browser
 * cannot call it directly). A result carries what an install form needs: the
 * remote endpoint or the package, and which headers or variables it asks for.
 */
export const AGENT_MCP_REGISTRY = {
  SEARCH_URL: 'https://registry.modelcontextprotocol.io/v0/servers',
  SEARCH_LIMIT: 20,
  QUERY_CHARS: 100,
  // Answers from far away (the server may sit in China) take up to ~3 s.
  TIMEOUT_MS: 10_000,
} as const;

export const AGENT_MCP_REGISTRY_ERROR = {
  UNAVAILABLE: 'registry_unavailable',
} as const;

export interface AgentMcpRegistryInput {
  name: string;
  description?: string;
  required: boolean;
  secret: boolean;
  /** A value shape the server documents, e.g. "Bearer {api_key}". */
  template?: string;
}

export interface AgentMcpRegistryServer {
  /** Registry name, e.g. io.github.owner/server. */
  id: string;
  description: string;
  version?: string;
  repositoryUrl?: string;
  /** A remote endpoint, when the server offers one. */
  remote?: { transport: typeof AGENT_MCP_TRANSPORT.HTTP | typeof AGENT_MCP_TRANSPORT.SSE; url: string; headers: AgentMcpRegistryInput[] };
  /** An npm package run with npx, when the server offers one. */
  npm?: { identifier: string; version?: string; env: AgentMcpRegistryInput[] };
}
