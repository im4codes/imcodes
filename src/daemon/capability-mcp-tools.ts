import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AGENT_MCP_ACTION, AGENT_MCP_ERROR, AGENT_MCP_TRANSPORT, readAgentMcpServerSpec } from '../../shared/agent-mcp.js';
import { runAgentMcp } from './agent-mcp.js';
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
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
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
  /** Resolve caller context for binding-scoped Skill activation only. */
  resolveCapabilityIdentity?: (caller: McpRuntimeCaller) => Promise<CapabilityRuntimeIdentity | null>;
  /** Installs a Skill into this machine's `~/.agents/skills`; tests replace it. */
  runAgentSkills?: typeof runAgentSkillsOnThisMachine;
  /** Adds an MCP server to this machine's agent configs; tests replace it. */
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

const sourceSchema = z.strictObject({
  kind: sourceKind.describe('Use mcp_config for an AI-composed MCP definition; URL is a direct Streamable HTTP endpoint or Skill source.'),
  value: z.string().max(CAPABILITY_LIMITS.SOURCE_CHARS).optional().describe('Direct MCP Streamable HTTP endpoint, Skill URL/repository locator, or daemon-local Skill path.'),
  repositorySubdir: z.string().max(CAPABILITY_LIMITS.PATH_BYTES).optional().describe('Repository-relative Skill directory.'),
  inlineFiles: z.record(z.string(), z.string()).optional().describe('Portable package file map including SKILL.md.'),
  mcpConfig: z.record(z.string(), z.unknown()).optional().describe('AI-composed normalized non-secret MCP definition; no installer URL or package download is required.'),
});

export const CAPABILITY_MCP_INPUT_SCHEMAS = {
  [CAPABILITY_MCP_TOOL.LIST]: z.strictObject({
    kind: kind.optional().describe('Optional Skill or MCP filter.'),
    state: z.enum(CAPABILITY_LIFECYCLE_STATES).optional().describe('Optional lifecycle-state filter.'),
    scope: scope.optional().describe('Optional install-scope filter.'),
    query: z.string().max(CAPABILITY_LIMITS.DISPLAY_NAME_CHARS).optional().describe('Optional name/source search text.'),
    limit: z.number().int().min(1).max(CAPABILITY_LIMITS.LIST_MAX).optional(),
  }),
  [CAPABILITY_MCP_TOOL.INSTALL]: z.strictObject({
    capabilityId: z.string().min(1).max(128).optional().describe('Exact installed capability id when updating; never inferred by name.'),
    bindingId: z.string().min(1).max(128).optional().describe('Exact installed binding id when updating; required with capabilityId.'),
    kind: kind.describe('Portable Agent Skill or MCP service definition.'),
    source: sourceSchema,
    displayName: z.string().max(CAPABILITY_LIMITS.DISPLAY_NAME_CHARS).optional(),
    scope: scope.describe('Local, account, canonical project, or exact session scope.'),
    scopeId: z.string().max(256).optional().describe('Required canonical ID for project/session scope.'),
    providers: z.array(z.string().min(1).max(64)).max(CAPABILITY_LIMITS.PROVIDERS).optional().describe('Optional provider filters.'),
    machines: z.array(z.string().min(1).max(128)).max(CAPABILITY_LIMITS.MACHINES).optional().describe('Optional target machine/server IDs.'),
    idempotencyKey: z.string().min(1).max(128).describe('Stable retry key for one logical request.'),
    userIntent: z.string().max(CAPABILITY_LIMITS.USER_INTENT_BYTES).optional().describe('Original user instruction; never confirmation.'),
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

/**
 * MCP servers go into the configs of the agents on this machine through the
 * add-mcp SDK, where those agents load them. Values the user gave for keys or
 * tokens are written with it; the MCP tab adds them otherwise.
 */
async function installAgentMcp(
  input: CapabilityInstallRequest,
  run: typeof runAgentMcp,
): Promise<CallToolResult> {
  const config = (input.source?.mcpConfig ?? {}) as Record<string, unknown>;
  const remoteUrl = input.source?.kind === CAPABILITY_SOURCE_KIND.URL ? input.source.value : config.url;
  const transport = typeof config.transport === 'string'
    ? (config.transport === 'streamable-http' ? AGENT_MCP_TRANSPORT.HTTP : config.transport)
    : remoteUrl ? AGENT_MCP_TRANSPORT.HTTP : AGENT_MCP_TRANSPORT.STDIO;
  let fallbackName: string | undefined;
  try { fallbackName = typeof remoteUrl === 'string' ? new URL(remoteUrl).hostname.split('.')[0] : undefined; } catch { /* no URL */ }
  const server = readAgentMcpServerSpec({
    name: config.name ?? input.displayName ?? fallbackName,
    transport,
    ...(transport === AGENT_MCP_TRANSPORT.STDIO
      ? { command: config.command, ...(config.args ? { args: config.args } : {}), ...(plainValues(config.env) ? { env: plainValues(config.env) } : {}) }
      : { url: remoteUrl, ...(plainValues(config.headers) ? { headers: plainValues(config.headers) } : {}) }),
  });
  if (!server) {
    return toolResult(error(
      CAPABILITY_ERROR.INVALID_INPUT,
      'An MCP server needs a name and either a command (stdio, e.g. npx with its package) or an https:// URL (http/sse); names like imcodes-memory are reserved.',
    ));
  }
  const result = await run({ action: AGENT_MCP_ACTION.ADD, server });
  const payload = {
    status: result.ok ? 'ok' : 'error',
    ...(result.ok ? {} : { reason: result.error ?? AGENT_MCP_ERROR.FAILED }),
    server: server.name,
    agents: (result.results ?? []).map((entry) => ({ agent: entry.agent, ok: entry.ok, ...(entry.error ? { error: entry.error } : {}) })),
    note: 'Written to the MCP config of each agent on this machine; sessions started from now on load it. Keys or tokens not given here can be added in the IM.codes MCP tab.',
  };
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: !result.ok,
  };
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
            return toolResult(await service.list(raw as CapabilityListRequest));
          case CAPABILITY_MCP_TOOL.INSTALL: {
            const input = raw as CapabilityInstallRequest;
            if (input?.kind === CAPABILITY_KIND.SKILL) {
              return await installAgentSkill(input, deps.runAgentSkills ?? runAgentSkillsOnThisMachine);
            }
            if (input?.kind === CAPABILITY_KIND.MCP) {
              return await installAgentMcp(input, deps.runAgentMcp ?? runAgentMcp);
            }
            const issue = validateCapabilityInstallRequest(input);
            return toolResult(issue ? error(CAPABILITY_ERROR.INVALID_INPUT, issue) : await service.install(input));
          }
          case CAPABILITY_MCP_TOOL.STATUS:
            return toolResult(await service.status(raw as CapabilityStatusRequest));
          case CAPABILITY_MCP_TOOL.MANAGE: {
            const input = raw as CapabilityManageRequest;
            if ((input.action === CAPABILITY_MANAGE_ACTION.UNINSTALL
              || input.action === CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS) && !input.userIntent?.trim()) {
              return toolResult(error(CAPABILITY_ERROR.INVALID_INPUT, `${input.action} requires the explicit user instruction in userIntent`));
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
