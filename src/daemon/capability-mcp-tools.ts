import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import { LEGACY_DAEMON_LOCAL_USER_ID } from '../../shared/memory-namespace.js';
import { NODE_ROLE, type NodeRole } from '../../shared/remote-exec.js';
import type { McpRuntimeCaller } from './memory-mcp-caller.js';
import type { ContextNamespace } from '../../shared/context-types.js';

export interface CapabilityMcpToolDeps {
  capabilityService?: CapabilityService;
  nodeRole?: NodeRole;
  isCapabilityOwner?: (caller: McpRuntimeCaller) => boolean;
  /** Resolve the current owner over the daemon-local authenticated link. */
  resolveCapabilityIdentity?: (caller: McpRuntimeCaller) => Promise<CapabilityRuntimeIdentity | null>;
}

export interface CapabilityRuntimeIdentity {
  ownerId: string;
  providerId: string;
  serverId: string;
  sessionId: string;
  namespace: ContextNamespace;
  projectDir?: string;
}

export interface CapabilityMcpRegistrationController {
  refresh(): Promise<boolean>;
  stop(): void;
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
    limit: z.number().int().min(1).max(CAPABILITY_LIMITS.LIST_MAX).optional().describe('Bounded result limit.'),
  }),
  [CAPABILITY_MCP_TOOL.INSTALL]: z.strictObject({
    capabilityId: z.string().min(1).max(128).optional().describe('Exact installed capability id when updating; never inferred by name.'),
    bindingId: z.string().min(1).max(128).optional().describe('Exact installed binding id when updating; required with capabilityId.'),
    kind: kind.describe('Portable Agent Skill or MCP service definition.'),
    source: sourceSchema,
    displayName: z.string().max(CAPABILITY_LIMITS.DISPLAY_NAME_CHARS).optional().describe('Optional display name.'),
    scope: scope.describe('Local, account, canonical project, or exact session scope.'),
    scopeId: z.string().max(256).optional().describe('Required canonical ID for project/session scope.'),
    providers: z.array(z.string().min(1).max(64)).max(CAPABILITY_LIMITS.PROVIDERS).optional().describe('Optional provider filters.'),
    machines: z.array(z.string().min(1).max(128)).max(CAPABILITY_LIMITS.MACHINES).optional().describe('Optional target machine/server IDs.'),
    idempotencyKey: z.string().min(1).max(128).describe('Stable retry key for one logical request.'),
    userIntent: z.string().max(CAPABILITY_LIMITS.USER_INTENT_BYTES).optional().describe('Original user instruction; never confirmation.'),
  }).refine((value) => Boolean(value.capabilityId) === Boolean(value.bindingId), 'capabilityId and bindingId must be supplied together'),
  [CAPABILITY_MCP_TOOL.STATUS]: z.strictObject({
    operationId: z.string().min(1).max(128).optional().describe('Operation id returned by capability_install.'),
    capabilityId: z.string().min(1).max(128).optional().describe('Installed capability id.'),
    activate: z.boolean().optional().describe('Resolve bounded instructions for this exact authorized Skill and caller context.'),
  }).refine((value) => Number(Boolean(value.operationId)) + Number(Boolean(value.capabilityId)) === 1
    && (!value.activate || Boolean(value.capabilityId)), 'provide exactly one id; activate requires capabilityId'),
  [CAPABILITY_MCP_TOOL.MANAGE]: z.strictObject({
    action: z.enum(CAPABILITY_AVAILABLE_MANAGEMENT_ACTIONS).describe('Management action currently available through AI management.'),
    capabilityId: z.string().min(1).max(128).optional().describe('Preferred exact capability id.'),
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

export function isAuthenticatedCapabilityOwner(caller: McpRuntimeCaller): boolean {
  const userId = caller.userId.trim();
  return Boolean(
    caller.sessionName
    && userId
    && userId !== LEGACY_DAEMON_LOCAL_USER_ID
    && caller.namespace.userId?.trim() === userId,
  );
}

export function canRegisterCapabilityMcpTools(caller: McpRuntimeCaller, deps: CapabilityMcpToolDeps): boolean {
  if (!deps.capabilityService || (deps.nodeRole ?? NODE_ROLE.FULL) !== NODE_ROLE.FULL) return false;
  if (deps.resolveCapabilityIdentity) {
    return Boolean(caller.sessionName && caller.providerId && caller.serverId && caller.capabilityToken);
  }
  return (deps.isCapabilityOwner ?? isAuthenticatedCapabilityOwner)(caller);
}

function exactRuntimeIdentity(caller: McpRuntimeCaller, value: CapabilityRuntimeIdentity | null): value is CapabilityRuntimeIdentity {
  return Boolean(value?.ownerId
    && value.namespace.userId === value.ownerId
    && (caller.userId === LEGACY_DAEMON_LOCAL_USER_ID || caller.userId === value.ownerId)
    && (!caller.namespace.userId
      || caller.namespace.userId === LEGACY_DAEMON_LOCAL_USER_ID
      || caller.namespace.userId === value.ownerId)
    && value.providerId === caller.providerId
    && value.serverId === caller.serverId
    && value.sessionId === caller.sessionName);
}

function error(reason: CapabilityErrorResult['reason'], message: string, retryable = false): CapabilityErrorResult {
  return { status: 'error', reason, error: message, ...(retryable ? { retryable: true } : {}) };
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
): CapabilityMcpRegistrationController | undefined {
  if (!canRegisterCapabilityMcpTools(caller, deps)) return undefined;
  const service = deps.capabilityService!;
  const registered: RegisteredTool[] = [];
  let enabled = !deps.resolveCapabilityIdentity;
  let stopped = false;
  for (const name of CAPABILITY_MCP_TOOL_NAMES) {
    const contract = CAPABILITY_MCP_TOOL_CONTRACTS[name];
    const tool = server.registerTool(name, {
      description: contract.description,
      inputSchema: CAPABILITY_MCP_INPUT_SCHEMAS[name],
    }, async (raw: unknown) => {
      const identity = deps.resolveCapabilityIdentity
        ? await deps.resolveCapabilityIdentity(caller).catch(() => null)
        : null;
      if (deps.resolveCapabilityIdentity
        ? !exactRuntimeIdentity(caller, identity)
        : !(deps.isCapabilityOwner ?? isAuthenticatedCapabilityOwner)(caller)) {
        return toolResult(error(CAPABILITY_ERROR.FORBIDDEN, 'capability management requires an authenticated owner session'));
      }
      try {
        switch (name as CapabilityMcpToolName) {
          case CAPABILITY_MCP_TOOL.LIST:
            return toolResult(await service.list(raw as CapabilityListRequest));
          case CAPABILITY_MCP_TOOL.INSTALL: {
            const input = raw as CapabilityInstallRequest;
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
    });
    registered.push(tool);
    if (!enabled) tool.disable();
  }
  return {
    async refresh(): Promise<boolean> {
      if (stopped || !deps.resolveCapabilityIdentity) return enabled;
      const identity = await deps.resolveCapabilityIdentity(caller).catch(() => null);
      const next = exactRuntimeIdentity(caller, identity);
      if (next === enabled) return enabled;
      enabled = next;
      for (const tool of registered) {
        if (next) tool.enable();
        else tool.disable();
      }
      return enabled;
    },
    stop(): void {
      stopped = true;
      enabled = false;
      for (const tool of registered) tool.disable();
    },
  };
}
