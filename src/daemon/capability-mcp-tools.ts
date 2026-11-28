import { randomUUID } from 'node:crypto';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AGENT_MCP_ACTION,
  AGENT_MCP_ERROR,
  AGENT_MCP_LIMITS,
  AGENT_MCP_TRANSPORT,
  isAgentMcpName,
  isReservedAgentMcpName,
  readAgentMcpServerSpec,
  type AgentMcpTransport,
} from '../../shared/agent-mcp.js';
import { listAgentMcp, runAgentMcp, searchAgentMcpRegistry } from './agent-mcp.js';
import { AGENT_SKILLS_ACTION, AGENT_SKILLS_DIRECTORY_DISPLAY, AGENT_SKILLS_ERROR, isAgentSkillSource } from '../../shared/agent-skills.js';
import { runAgentSkillsOnThisMachine } from './agent-skills.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  CAPABILITY_ERROR,
  CAPABILITY_KIND,
  CAPABILITY_LIMITS,
  CAPABILITY_LIFECYCLE_STATES,
  CAPABILITY_AVAILABLE_MANAGEMENT_ACTIONS,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_MCP_TOOL,
  CAPABILITY_MCP_TOOL_CONTRACTS,
  CAPABILITY_MCP_TOOL_NAMES,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  validateCapabilityInstallRequest,
  type CapabilityErrorResult,
  type CapabilityInstallRequest,
  type CapabilityListRequest,
  type CapabilityManageRequest,
  type CapabilityMcpToolName,
  type CapabilityService,
  type CapabilityStatusRequest,
  type CapabilityToolResult,
} from '../../shared/capability-management.js';
import { NODE_ROLE, type NodeRole } from '../../shared/remote-exec.js';
import type { McpRuntimeCaller } from './memory-mcp-caller.js';
import type { ContextNamespace } from '../../shared/context-types.js';

export interface CapabilityMcpToolDeps {
  capabilityService?: CapabilityService;
  nodeRole?: NodeRole;
  /** Returns true (or throws to fail closed) when running inside a shared participant turn. */
  participantTurnRequired?: () => Promise<boolean>;
  /** Resolve caller context for binding-scoped Skill activation only. */
  resolveCapabilityIdentity?: (caller: McpRuntimeCaller) => Promise<CapabilityRuntimeIdentity | null>;
  /** Installs a Skill into this machine's `~/.agents/skills`; tests replace it. */
  runAgentSkills?: typeof runAgentSkillsOnThisMachine;
  /** Lists installed MCP servers across agent configs on this machine. */
  listAgentMcp?: typeof listAgentMcp;
  /** Searches the official MCP Registry directly. */
  searchAgentMcpRegistry?: typeof searchAgentMcpRegistry;
  /** Adds/removes an MCP server in this machine's agent configs; tests replace it. */
  runAgentMcp?: typeof runAgentMcp;
}

export interface CapabilityRuntimeIdentity {
  ownerId: string;
  providerId: string;
  serverId: string;
  sessionId: string;
  namespace: ContextNamespace;
  projectDir?: string;
}

const kind = z.enum(CAPABILITY_KIND);
const scope = z.enum(CAPABILITY_SCOPE);
const sourceKind = z.enum(CAPABILITY_SOURCE_KIND);

const anyObject = z.object({}).passthrough();
const mcpConfigSchema = z.object({
  name: z.string().optional(),
  transport: z.string().optional(),
  type: z.string().optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  args: z.array(z.string()).optional(),
  env: anyObject.optional(),
  url: z.string().optional(),
  headers: anyObject.optional(),
  mcpServers: anyObject.optional(),
  servers: anyObject.optional(),
}).passthrough();

const sourceSchema = z.strictObject({
  kind: sourceKind.describe('Use mcp_config for MCP; URL is a remote MCP endpoint or Skill source.'),
  value: z.string().max(CAPABILITY_LIMITS.SOURCE_CHARS).optional().describe('Remote MCP endpoint, Skill URL/repo, or local Skill path.'),
  repositorySubdir: z.string().max(CAPABILITY_LIMITS.PATH_BYTES).optional().describe('Repo-relative Skill directory.'),
  inlineFiles: z.record(z.string(), z.string()).optional().describe('Portable Skill files including SKILL.md.'),
  mcpConfig: mcpConfigSchema.optional().describe('AI-composed non-secret MCP config (stdio command/args, remote url/headers, transport/type, or mcpServers/servers wrapper); no installer URL required.'),
});

export const CAPABILITY_MCP_INPUT_SCHEMAS = {
  [CAPABILITY_MCP_TOOL.LIST]: z.strictObject({
    kind: kind.optional().describe('Skill or MCP filter.'),
    state: z.enum(CAPABILITY_LIFECYCLE_STATES).optional().describe('Lifecycle-state filter.'),
    scope: scope.optional().describe('Scope filter.'),
    query: z.string().max(CAPABILITY_LIMITS.DISPLAY_NAME_CHARS).optional().describe('Search text (required with searchRegistry).'),
    searchRegistry: z.boolean().optional().describe('Search official MCP Registry by query.'),
    limit: z.number().int().min(1).max(CAPABILITY_LIMITS.LIST_MAX).optional(),
  }),
  [CAPABILITY_MCP_TOOL.INSTALL]: z.strictObject({
    capabilityId: z.string().min(1).max(128).optional().describe('Exact installed id when updating.'),
    bindingId: z.string().min(1).max(128).optional().describe('Exact binding id required with capabilityId.'),
    kind: kind.describe('Skill or MCP definition.'),
    source: sourceSchema,
    displayName: z.string().max(CAPABILITY_LIMITS.DISPLAY_NAME_CHARS).optional(),
    scope: scope.optional().describe('local (default), account, project, or session.'),
    scopeId: z.string().max(256).optional().describe('Canonical project/session id.'),
    providers: z.array(z.string().min(1).max(64)).max(CAPABILITY_LIMITS.PROVIDERS).optional().describe('Target provider filters.'),
    machines: z.array(z.string().min(1).max(128)).max(CAPABILITY_LIMITS.MACHINES).optional().describe('Target machine/server IDs.'),
    idempotencyKey: z.string().min(1).max(128).optional().describe('Optional retry key.'),
    userIntent: z.string().max(CAPABILITY_LIMITS.USER_INTENT_BYTES).optional().describe('Original user instruction.'),
  }).refine((value) => Boolean(value.capabilityId) === Boolean(value.bindingId), 'capabilityId and bindingId must be supplied together'),
  [CAPABILITY_MCP_TOOL.STATUS]: z.strictObject({
    operationId: z.string().min(1).max(128).optional().describe('Operation id returned by capability_install.'),
    capabilityId: z.string().min(1).max(128).optional(),
    activate: z.boolean().optional().describe('Resolve bounded instructions for this exact authorized Skill and caller context.'),
  }).refine((value) => Number(Boolean(value.operationId)) + Number(Boolean(value.capabilityId)) === 1
    && (!value.activate || Boolean(value.capabilityId)), 'provide exactly one id; activate requires capabilityId'),
  [CAPABILITY_MCP_TOOL.MANAGE]: z.strictObject({
    action: z.enum(CAPABILITY_AVAILABLE_MANAGEMENT_ACTIONS).describe('Management action currently available through AI management.'),
    capabilityId: z.string().min(1).max(128).optional(),
    bindingId: z.string().min(1).max(128).optional().describe('Exact binding id for scope-specific lifecycle actions.'),
    operationId: z.string().min(1).max(128).optional().describe('Operation id for cancel_operation.'),
    name: z.string().min(1).max(CAPABILITY_LIMITS.DISPLAY_NAME_CHARS).optional().describe('Fallback display name; ambiguity returns choices.'),
    kind: kind.optional().describe('Optional kind disambiguator.'),
    scope: scope.optional().describe('Optional scope disambiguator.'),
    versionId: z.string().min(1).max(128).optional().describe('Immutable target version for rollback.'),
    expectedRevision: z.number().int().min(1).optional().describe('Current revision for optimistic conflict detection.'),
    userIntent: z.string().max(CAPABILITY_LIMITS.USER_INTENT_BYTES).optional().describe('Explicit user instruction, required for uninstall or credential deletion.'),
  }),
} as const;

export function canRegisterCapabilityMcpTools(_caller: McpRuntimeCaller, deps: CapabilityMcpToolDeps): boolean {
  // A FULL registered node authenticates every server-backed operation with its
  // bound node credential. Do not add a second session/user/nonce gate here:
  // provider children legitimately start with daemon-local fallback identity.
  return Boolean(deps.capabilityService && (deps.nodeRole ?? NODE_ROLE.FULL) === NODE_ROLE.FULL);
}

function error(reason: CapabilityErrorResult['reason'], message: string, retryable = false): CapabilityErrorResult {
  return { status: 'error', reason, error: message, ...(retryable ? { retryable: true } : {}) };
}

async function isParticipantTurnDenied(deps: CapabilityMcpToolDeps): Promise<boolean> {
  if (!deps.participantTurnRequired) return false;
  try {
    return (await deps.participantTurnRequired()) === true;
  } catch {
    return true;
  }
}

/**
 * Skills are not IM.codes packages: they go into this machine's
 * `~/.agents/skills` through the pinned `skills` CLI, where every agent here
 * already reads them. Other machines are installed from the Agent Skills tab.
 */
async function installAgentSkill(
  input: CapabilityInstallRequest,
  run: typeof runAgentSkillsOnThisMachine,
): Promise<CallToolResult> {
  const source = input.source?.value?.trim();
  if (!isAgentSkillSource(source)) {
    return toolResult(error(
      CAPABILITY_ERROR.INVALID_INPUT,
      'A Skill is installed from a GitHub owner/repo (optionally owner/repo/path) or an https:// URL into ~/.agents/skills. Pass it as source.value.',
    ));
  }
  const result = await run({ action: AGENT_SKILLS_ACTION.ADD, source });
  const payload = {
    status: result.ok ? 'ok' : 'error',
    ...(result.ok ? {} : { reason: result.error ?? AGENT_SKILLS_ERROR.CLI_FAILED }),
    installedTo: AGENT_SKILLS_DIRECTORY_DISPLAY,
    skills: result.skills.map((skill) => skill.name),
    ...(result.output ? { output: result.output } : {}),
    note: 'Agents on this machine load these Skills directly. To install on other machines, use the Agent Skills tab in IM.codes.',
  };
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: !result.ok,
  };
}

/** Plain string values only; a credential reference has no value to write. */
function plainValues(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/u;
const PROVIDER_TO_AGENT: Readonly<Record<string, string>> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  'claude-code-sdk': 'claude-code',
  codex: 'codex',
  'codex-sdk': 'codex',
  agy: 'antigravity',
  'agy-sdk': 'antigravity',
  antigravity: 'antigravity',
  gemini: 'gemini-cli',
  'gemini-cli': 'gemini-cli',
  copilot: 'github-copilot-cli',
  'github-copilot': 'github-copilot-cli',
  'github-copilot-cli': 'github-copilot-cli',
  opencode: 'opencode',
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unwrapMcpConfig(rawConfig: Record<string, unknown>): { config: Record<string, unknown>; error?: string } {
  const hasMcpServers = rawConfig.mcpServers !== undefined;
  const hasServers = rawConfig.servers !== undefined;
  if (hasMcpServers && hasServers) {
    return { config: {}, error: 'Provide either mcpServers or servers, not both.' };
  }
  const wrappedMap = hasMcpServers ? rawConfig.mcpServers : hasServers ? rawConfig.servers : undefined;
  if (wrappedMap !== undefined) {
    if (!isPlainRecord(wrappedMap)) {
      return { config: {}, error: 'mcpServers/servers must be an object mapping a server name to its config.' };
    }
    const entries = Object.entries(wrappedMap);
    if (entries.length !== 1) {
      return { config: {}, error: 'Pass exactly one MCP server per capability_install call inside mcpServers/servers.' };
    }
    const [entryName, entrySpec] = entries[0]!;
    if (!isPlainRecord(entrySpec)) {
      return { config: {}, error: `MCP server entry "${entryName}" must be an object.` };
    }
    return { config: { name: rawConfig.name ?? entryName, ...entrySpec } };
  }
  if (rawConfig.server !== undefined) {
    if (!isPlainRecord(rawConfig.server)) {
      return { config: {}, error: 'mcpConfig.server must be an object.' };
    }
    return { config: { ...(rawConfig.name !== undefined ? { name: rawConfig.name } : {}), ...rawConfig.server } };
  }
  return { config: rawConfig };
}

function normalizeMcpTransport(rawTransport: unknown, remoteUrl: unknown): AgentMcpTransport | null {
  if (rawTransport === undefined) {
    return remoteUrl ? AGENT_MCP_TRANSPORT.HTTP : AGENT_MCP_TRANSPORT.STDIO;
  }
  if (typeof rawTransport !== 'string') return null;
  const normalized = rawTransport.trim().toLowerCase();
  if (!normalized) return remoteUrl ? AGENT_MCP_TRANSPORT.HTTP : AGENT_MCP_TRANSPORT.STDIO;
  if (normalized === 'stdio' || normalized === 'local') return AGENT_MCP_TRANSPORT.STDIO;
  if (
    normalized === 'http'
    || normalized === 'streamable-http'
    || normalized === 'streamable_http'
    || normalized === 'streamablehttp'
    || normalized === 'streamable http'
    || normalized === 'remote'
  ) {
    return AGENT_MCP_TRANSPORT.HTTP;
  }
  if (normalized === 'sse') return AGENT_MCP_TRANSPORT.SSE;
  return null;
}

function sanitizeMcpName(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const cleaned = candidate
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[^A-Za-z0-9]+/u, '')
    .replace(/[._-]+$/u, '')
    .slice(0, AGENT_MCP_LIMITS.NAME_CHARS);
  return cleaned && isAgentMcpName(cleaned) ? cleaned : undefined;
}

function inferNameFromUrl(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== 'string') return undefined;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (/^\d+(?:\.\d+){3}$/u.test(host) || host === 'localhost') {
      return sanitizeMcpName(host);
    }
    const labels = host.split('.').filter(Boolean);
    while (labels.length > 2 && (labels[0] === 'mcp' || labels[0] === 'api' || labels[0] === 'www')) {
      labels.shift();
    }
    return sanitizeMcpName(labels[0] ?? host);
  } catch {
    return undefined;
  }
}

function inferNameFromStdio(command: unknown, args: unknown): string | undefined {
  if (typeof command !== 'string') return undefined;
  const argList = Array.isArray(args) ? args.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  const pkgArg = argList.find((arg) => !arg.startsWith('-'));
  if (pkgArg) {
    let candidate = pkgArg.trim();
    if (candidate.startsWith('@') && candidate.includes('/')) {
      candidate = candidate.slice(candidate.indexOf('/') + 1);
    }
    const versionSep = candidate.indexOf('@', 1);
    if (versionSep > 0) candidate = candidate.slice(0, versionSep);
    candidate = candidate.split(/[\\/]/u).pop() ?? candidate;
    const sanitized = sanitizeMcpName(candidate);
    if (sanitized) return sanitized;
  }
  return sanitizeMcpName(command.split(/[\\/]/u).pop());
}

function mapProvidersToAgents(providers: readonly string[] | undefined): { agents?: string[]; error?: string } {
  if (!providers || providers.length === 0) return {};
  const mapped: string[] = [];
  for (const raw of providers) {
    const key = raw.trim().toLowerCase();
    const agent = PROVIDER_TO_AGENT[key] ?? (AGENT_ID_PATTERN.test(key) ? key : undefined);
    if (!agent) {
      return { error: `Unsupported provider/agent filter "${raw}".` };
    }
    if (!mapped.includes(agent)) mapped.push(agent);
  }
  return { agents: mapped };
}

function jsonPayloadResult(payload: Record<string, unknown>, isError: boolean): CallToolResult {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError,
  };
}

/**
 * MCP servers go into the configs of the agents on this machine through the
 * add-mcp SDK, where those agents load them. Values the user gave for keys or
 * tokens are written with it; the MCP tab adds them otherwise.
 */
async function installAgentMcp(
  input: CapabilityInstallRequest,
  run: typeof runAgentMcp,
): Promise<CallToolResult> {
  const rawConfig = isPlainRecord(input.source?.mcpConfig) ? input.source.mcpConfig : {};
  const unwrapped = unwrapMcpConfig(rawConfig);
  if (unwrapped.error) {
    return toolResult(error(CAPABILITY_ERROR.INVALID_INPUT, unwrapped.error));
  }
  const config = unwrapped.config;
  const { agents: targetAgents, error: providerError } = mapProvidersToAgents(input.providers);
  if (providerError) {
    return toolResult(error(CAPABILITY_ERROR.INVALID_INPUT, providerError));
  }

  const remoteUrl = input.source?.kind === CAPABILITY_SOURCE_KIND.URL ? input.source.value : config.url;
  const declaredTransport = config.transport ?? config.type;
  const transport = normalizeMcpTransport(declaredTransport, remoteUrl);
  if (!transport) {
    return toolResult(error(
      CAPABILITY_ERROR.INVALID_INPUT,
      `Unsupported MCP transport "${String(declaredTransport)}". Use stdio, http (streamable-http / streamable_http), or sse.`,
    ));
  }

  let commandValue = config.command;
  let argsValue = config.args;
  if (transport === AGENT_MCP_TRANSPORT.STDIO) {
    if (Array.isArray(commandValue)) {
      if (commandValue.length === 0 || !commandValue.every((part): part is string => typeof part === 'string')) {
        return toolResult(error(CAPABILITY_ERROR.INVALID_INPUT, 'Array command must be a non-empty list of strings.'));
      }
      if (argsValue === undefined) {
        argsValue = commandValue.slice(1);
        commandValue = commandValue[0];
      } else if (commandValue.length === 1) {
        commandValue = commandValue[0];
      } else {
        return toolResult(error(CAPABILITY_ERROR.INVALID_INPUT, "Put only the executable in command (e.g. 'npx') and pass flags/packages in args."));
      }
    }
    if (typeof commandValue === 'string' && !/^[A-Za-z]:\\/u.test(commandValue) && /\s/u.test(commandValue.trim())) {
      return toolResult(error(
        CAPABILITY_ERROR.INVALID_INPUT,
        "Put only the executable in command (e.g. 'npx') and pass flags/packages in args.",
      ));
    }
  }

  const fallbackName = transport === AGENT_MCP_TRANSPORT.STDIO
    ? inferNameFromStdio(commandValue, argsValue)
    : inferNameFromUrl(remoteUrl);
  const server = readAgentMcpServerSpec({
    name: config.name ?? input.displayName ?? fallbackName,
    transport,
    ...(transport === AGENT_MCP_TRANSPORT.STDIO
      ? {
          command: commandValue,
          ...(argsValue !== undefined ? { args: argsValue } : {}),
          ...(plainValues(config.env) ? { env: plainValues(config.env) } : {}),
        }
      : {
          url: remoteUrl,
          ...(plainValues(config.headers) ? { headers: plainValues(config.headers) } : {}),
        }),
  });
  if (!server) {
    return toolResult(error(
      CAPABILITY_ERROR.INVALID_INPUT,
      'An MCP server needs a name and either a command (stdio, e.g. npx with its package in args) or an https:// URL (http/sse); names like imcodes-memory are reserved.',
    ));
  }

  const result = await run({
    action: AGENT_MCP_ACTION.ADD,
    server,
    ...(targetAgents ? { agents: targetAgents } : {}),
  });
  const results = result.results ?? [];
  const anyOk = results.some((entry) => entry.ok);
  const isOk = result.ok || anyOk;
  const partial = isOk && results.some((entry) => !entry.ok);
  const payload: Record<string, unknown> = {
    status: isOk ? 'ok' : 'error',
    ...(isOk ? {} : { reason: result.error ?? AGENT_MCP_ERROR.FAILED }),
    ...(partial ? { partial: true } : {}),
    server: server.name,
    agents: results.map((entry) => ({
      agent: entry.agent,
      ok: entry.ok,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.dropped?.length ? { dropped: entry.dropped } : {}),
    })),
    note: 'Written to the MCP config of each agent on this machine; sessions started from now on load it. Keys or tokens not given here can be added in the IM.codes MCP tab.',
  };
  return jsonPayloadResult(payload, !isOk);
}

async function listCapabilitiesWithAgentMcp(
  input: CapabilityListRequest,
  service: CapabilityService,
  deps: CapabilityMcpToolDeps,
): Promise<CallToolResult> {
  if (input.searchRegistry) {
    const query = input.query?.trim() ?? '';
    if (!query) {
      return toolResult(error(CAPABILITY_ERROR.INVALID_INPUT, 'searchRegistry=true requires a non-empty query.'));
    }
    const searchFn = deps.searchAgentMcpRegistry ?? searchAgentMcpRegistry;
    try {
      const servers = await searchFn(query);
      const limit = input.limit ?? 10;
      return jsonPayloadResult({
        status: 'ok',
        registry: true,
        query,
        servers: servers.slice(0, limit),
      }, false);
    } catch (err) {
      return toolResult(error(
        CAPABILITY_ERROR.ACQUISITION_FAILED,
        err instanceof Error ? err.message : 'Official MCP Registry lookup failed',
        true,
      ));
    }
  }

  const serviceResult = await service.list(input);
  if (serviceResult.status === 'error') return toolResult(serviceResult);

  if (!deps.listAgentMcp
    || (input.kind !== undefined && input.kind !== CAPABILITY_KIND.MCP)
    || (input.scope !== undefined && input.scope !== CAPABILITY_SCOPE.LOCAL)) {
    return toolResult(serviceResult);
  }

  const mcpList = await deps.listAgentMcp();
  const query = input.query?.trim().toLowerCase() ?? '';
  const stateMatches = input.state === undefined || input.state === CAPABILITY_STATE.ACTIVE;
  const mcpItems = stateMatches
    ? mcpList.servers
      .filter((entry) => {
        if (!query) return true;
        return [
          entry.name,
          entry.url ?? '',
          entry.command ?? '',
          entry.packageName ?? '',
          entry.agents.join(' '),
        ].some((field) => field.toLowerCase().includes(query));
      })
      .map((entry) => ({
        id: `mcp:${entry.name}`,
        revision: 1,
        kind: CAPABILITY_KIND.MCP,
        name: entry.name,
        state: CAPABILITY_STATE.ACTIVE,
        scope: CAPABILITY_SCOPE.LOCAL,
        sourceKind: entry.transport === AGENT_MCP_TRANSPORT.STDIO
          ? CAPABILITY_SOURCE_KIND.MCP_CONFIG
          : CAPABILITY_SOURCE_KIND.URL,
        ...(entry.url
          ? { sourceLabel: entry.url }
          : entry.packageName
            ? { sourceLabel: `${entry.command ?? 'npx'} ${entry.packageName}` }
            : entry.command
              ? { sourceLabel: entry.command }
              : {}),
        readiness: CAPABILITY_READINESS.READY,
        findings: [],
        updatedAt: 0,
        transport: entry.transport,
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.command ? { command: entry.command } : {}),
        ...(entry.packageName ? { packageName: entry.packageName } : {}),
        envNames: entry.envNames,
        headerNames: entry.headerNames,
        agents: entry.agents,
      }))
    : [];

  const limit = input.limit ?? CAPABILITY_LIMITS.LIST_DEFAULT;
  const items = [...mcpItems, ...serviceResult.items].slice(0, limit);
  return jsonPayloadResult({
    status: 'ok',
    items,
    detectedAgents: mcpList.agents,
  }, false);
}

async function uninstallAgentMcp(
  targetName: string | undefined,
  run: typeof runAgentMcp,
): Promise<CallToolResult> {
  if (!targetName) {
    return toolResult(error(CAPABILITY_ERROR.INVALID_INPUT, 'uninstall with kind=mcp requires the MCP server name.'));
  }
  if (isReservedAgentMcpName(targetName)) {
    return jsonPayloadResult({
      status: 'error',
      reason: AGENT_MCP_ERROR.RESERVED_NAME,
      error: `${targetName} is IM.codes built-in MCP server and cannot be uninstalled here.`,
    }, true);
  }
  if (!isAgentMcpName(targetName)) {
    return toolResult(error(CAPABILITY_ERROR.INVALID_INPUT, `Invalid MCP server name "${targetName}".`));
  }
  const result = await run({ action: AGENT_MCP_ACTION.REMOVE, name: targetName });
  if (result.error === AGENT_MCP_ERROR.RESERVED_NAME) {
    return jsonPayloadResult({
      status: 'error',
      reason: AGENT_MCP_ERROR.RESERVED_NAME,
      error: `${targetName} is IM.codes built-in MCP server and cannot be uninstalled here.`,
    }, true);
  }
  const results = result.results ?? [];
  if (results.length === 0) {
    return toolResult(error(CAPABILITY_ERROR.NOT_FOUND, `MCP server "${targetName}" is not installed on any detected agent.`));
  }
  const anyOk = results.some((entry) => entry.ok);
  const isOk = result.ok || anyOk;
  const partial = isOk && results.some((entry) => !entry.ok);
  return jsonPayloadResult({
    status: isOk ? 'ok' : 'error',
    ...(isOk ? { removed: targetName } : { reason: result.error ?? AGENT_MCP_ERROR.FAILED }),
    ...(partial ? { partial: true } : {}),
    agents: results.map((entry) => ({
      agent: entry.agent,
      ok: entry.ok,
      ...(entry.error ? { error: entry.error } : {}),
    })),
  }, !isOk);
}

function resolveAgentMcpTargetName(input: CapabilityManageRequest): string | undefined {
  const byName = input.name?.trim();
  if (byName) return byName;
  const byId = input.capabilityId?.trim();
  if (!byId) return undefined;
  return byId.startsWith('mcp:') ? byId.slice(4) : byId;
}

function toolResult(result: CapabilityToolResult): CallToolResult {
  return {
    structuredContent: result as unknown as Record<string, unknown>,
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: result.status === 'error',
  };
}

export function registerCapabilityMcpTools(
  server: McpServer,
  caller: McpRuntimeCaller,
  deps: CapabilityMcpToolDeps,
): ReadonlyMap<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>();
  if (!canRegisterCapabilityMcpTools(caller, deps)) return registered;
  const service = deps.capabilityService!;
  for (const name of CAPABILITY_MCP_TOOL_NAMES) {
    const contract = CAPABILITY_MCP_TOOL_CONTRACTS[name];
    registered.set(name, server.registerTool(name, {
      description: contract.description,
      inputSchema: CAPABILITY_MCP_INPUT_SCHEMAS[name],
    }, async (raw: unknown) => {
      try {
        switch (name as CapabilityMcpToolName) {
          case CAPABILITY_MCP_TOOL.LIST:
            return await listCapabilitiesWithAgentMcp((raw ?? {}) as CapabilityListRequest, service, deps);
          case CAPABILITY_MCP_TOOL.INSTALL: {
            if (await isParticipantTurnDenied(deps)) {
              return toolResult(error(CAPABILITY_ERROR.FORBIDDEN, 'capability_install is not permitted during a participant turn'));
            }
            const rawInput = raw as Partial<CapabilityInstallRequest>;
            if (rawInput?.kind === CAPABILITY_KIND.SKILL) {
              return await installAgentSkill(rawInput as CapabilityInstallRequest, deps.runAgentSkills ?? runAgentSkillsOnThisMachine);
            }
            if (rawInput?.kind === CAPABILITY_KIND.MCP) {
              return await installAgentMcp(rawInput as CapabilityInstallRequest, deps.runAgentMcp ?? runAgentMcp);
            }
            const normalizedInput: CapabilityInstallRequest = {
              ...(rawInput as CapabilityInstallRequest),
              scope: rawInput.scope ?? CAPABILITY_SCOPE.LOCAL,
              idempotencyKey: rawInput.idempotencyKey ?? randomUUID(),
            };
            const issue = validateCapabilityInstallRequest(normalizedInput);
            return toolResult(issue ? error(CAPABILITY_ERROR.INVALID_INPUT, issue) : await service.install(normalizedInput));
          }
          case CAPABILITY_MCP_TOOL.STATUS:
            return toolResult(await service.status(raw as CapabilityStatusRequest));
          case CAPABILITY_MCP_TOOL.MANAGE: {
            if (await isParticipantTurnDenied(deps)) {
              return toolResult(error(CAPABILITY_ERROR.FORBIDDEN, 'capability_manage is not permitted during a participant turn'));
            }
            const input = raw as CapabilityManageRequest;
            if ((input.action === CAPABILITY_MANAGE_ACTION.UNINSTALL
              || input.action === CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS) && !input.userIntent?.trim()) {
              return toolResult(error(CAPABILITY_ERROR.INVALID_INPUT, `${input.action} requires the explicit user instruction in userIntent`));
            }
            if (input.action === CAPABILITY_MANAGE_ACTION.UNINSTALL) {
              const targetName = resolveAgentMcpTargetName(input);
              const runMcp = deps.runAgentMcp ?? runAgentMcp;
              if (input.kind === CAPABILITY_KIND.MCP) {
                return await uninstallAgentMcp(targetName, runMcp);
              }
              const managed = await service.manage(input);
              if (input.kind === undefined
                && managed.status === 'error'
                && managed.reason === CAPABILITY_ERROR.NOT_FOUND
                && targetName
                && (isReservedAgentMcpName(targetName) || isAgentMcpName(targetName))) {
                if (isReservedAgentMcpName(targetName)) {
                  return await uninstallAgentMcp(targetName, runMcp);
                }
                if (!deps.listAgentMcp) {
                  return await uninstallAgentMcp(targetName, runMcp);
                }
                const current = await deps.listAgentMcp();
                if (current.servers.some((entry) => entry.name === targetName)) {
                  return await uninstallAgentMcp(targetName, runMcp);
                }
              }
              return toolResult(managed);
            }
            return toolResult(await service.manage(input));
          }
        }
      } catch {
        return toolResult(error(CAPABILITY_ERROR.INTERNAL_ERROR, 'capability service failed safely', true));
      }
    }));
  }
  return registered;
}
