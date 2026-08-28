import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import http from 'http';
import { resolveLiveHookPort } from './hook-port.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import {
  MemoryMcpCallerEnvError,
  parseMcpRuntimeCallerFromEnv,
  type McpRuntimeCaller,
} from './memory-mcp-caller.js';
import { registerAliasMcpTools, registerMemoryMcpTools, type MemoryMcpToolDeps } from './memory-mcp-tools.js';
import { registerMessagePinMcpTools, type MessagePinMcpToolDeps } from './message-pin-mcp-tools.js';
import { registerSupervisionMcpTools, type SupervisionMcpToolDeps } from './supervision-mcp-tools.js';
import { createDaemonMachineToolDeps } from './machine-mcp-deps.js';
import { loadStore, type SessionRecord } from '../store/session-store.js';
import { isDaemonCapabilityAdvertised } from './server-link.js';
import { EXECUTION_CLONE_CAPABILITY_V1 } from '../../shared/execution-clone.js';
import { resolveExecutionCloneLimitsForParentRun } from './execution-clone-limits-resolver.js';
import {
  registerCapabilityMcpTools,
  type CapabilityRuntimeIdentity,
} from './capability-mcp-tools.js';
import { createServerCapabilityService } from '../capability/server-capability-service.js';
import { activateCapabilitySkill } from '../capability/capability-skill-activation.js';
import {
  CAPABILITY_AI_SYSTEM_INSTRUCTIONS,
  CAPABILITY_ERROR,
  type CapabilityErrorResult,
} from '../../shared/capability-management.js';
import { isMemoryScope, validateMemoryScopeIdentity } from '../../shared/memory-scope.js';
import type { ContextNamespace } from '../../shared/context-types.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../shared/memory-mcp-contracts.js';

export interface MemoryMcpServerOptions {
  env?: Record<string, string | undefined>;
  toolDeps?: MemoryMcpToolDeps;
  messagePinToolDeps?: MessagePinMcpToolDeps;
  /** Without this, supervision tools register with empty deps and every
   *  task-registry call fails with "registry not bound". */
  supervisionToolDeps?: SupervisionMcpToolDeps;
}

export function createMemoryMcpServer(
  caller: McpRuntimeCaller,
  toolDeps: MemoryMcpToolDeps = {},
  messagePinToolDeps: MessagePinMcpToolDeps = {},
  supervisionToolDeps: SupervisionMcpToolDeps = {},
): McpServer {
  const server = new McpServer({
    name: IMCODES_MEMORY_MCP_SERVER_NAME,
    version: '0.1.0',
  }, {
    instructions: CAPABILITY_AI_SYSTEM_INSTRUCTIONS,
  });
  registerMemoryMcpTools(server, caller, toolDeps);
  registerCapabilityMcpTools(server, caller, toolDeps);
  // Exact server-backed stores share this MCP server surface but stay outside
  // the fuzzy-memory contract list and schema firewall.
  registerAliasMcpTools(server, caller);
  registerMessagePinMcpTools(server, caller, messagePinToolDeps);
  // Supervision registry: exact server-backed operations, same separation as
  // alias/message-pin tools -- outside the fuzzy-memory contract + firewall.
  registerSupervisionMcpTools(server, caller, supervisionToolDeps);
  return server;
}

function capabilityError(message: string): CapabilityErrorResult {
  return { status: 'error', reason: CAPABILITY_ERROR.FORBIDDEN, error: message, retryable: false };
}

export async function resolveDaemonCapabilityIdentity(caller: McpRuntimeCaller): Promise<CapabilityRuntimeIdentity | null> {
  if (!caller.sessionName || !caller.providerId || !caller.serverId) return null;
  const port = await resolveLiveHookPort();
  if (!port) return null;
  try {
    const response = await postHookSend(port, {
      providerId: caller.providerId,
      serverId: caller.serverId,
    }, '/capability-identity', caller.sessionName, 2_000);
    const namespace = response.namespace;
    const validNamespace = Boolean(namespace && typeof namespace === 'object' && !Array.isArray(namespace)
      && isMemoryScope((namespace as ContextNamespace).scope)
      && validateMemoryScopeIdentity((namespace as ContextNamespace).scope, {
        user_id: (namespace as ContextNamespace).userId,
        project_id: (namespace as ContextNamespace).projectId,
        workspace_id: (namespace as ContextNamespace).workspaceId,
        org_id: (namespace as ContextNamespace).enterpriseId,
        tenant_id: (namespace as ContextNamespace).localTenant,
      }).ok);
    return response.ok === true
      && typeof response.ownerId === 'string'
      && response.providerId === caller.providerId
      && response.serverId === caller.serverId
      && response.sessionId === caller.sessionName
      && validNamespace
      && (response.projectDir === undefined
        || (typeof response.projectDir === 'string'
          && response.projectDir.length > 0
          && Buffer.byteLength(response.projectDir, 'utf8') <= 4096))
      ? {
          ownerId: response.ownerId,
          providerId: caller.providerId,
          serverId: caller.serverId,
          sessionId: caller.sessionName,
          namespace: namespace as ContextNamespace,
          ...(typeof response.projectDir === 'string' ? { projectDir: response.projectDir } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

const DELEGATION_REPLY_HOOK_TIMEOUT_MS = 10_000;

export async function postHookSend(
  port: number,
  body: Record<string, unknown>,
  hookPath = '/send',
  senderSessionName?: string,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: hookPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(senderSessionName ? { 'x-imcodes-session': senderSessionName } : {}),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
          if ((res.statusCode ?? 500) >= 400 || parsed.ok === false) {
            reject(new Error(typeof parsed.error === 'string' ? parsed.error : `hook send failed with status ${res.statusCode ?? 0}`));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
    });
    if (timeoutMs && timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`hook request timed out after ${timeoutMs}ms`));
      });
    }
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Compose the production stdio-MCP send defaults onto the (possibly test-injected)
 * `toolDeps`, PER FIELD. Every send-dep field independently preserves an injected
 * value and falls back to the daemon-backed default when absent. This MUST NOT be
 * all-or-nothing: a caller that supplies ONLY a custom `dispatchMessage` still
 * gets the default `cancelSession` (so `send_stop` is not `internal_error`), the
 * capability resolver, and the run-authoritative limit resolver (so a model-driven
 * clone create still enforces per-run caps). Exported for unit-testing the
 * production seam without a full stdio harness.
 */
export function mergeDefaultToolDeps(caller: McpRuntimeCaller, toolDeps: MemoryMcpToolDeps): MemoryMcpToolDeps {
  const usesDefaultCapabilityService = !toolDeps.capabilityService && Boolean(caller.serverId);
  const resolveCapabilityIdentity = toolDeps.resolveCapabilityIdentity
    ?? (usesDefaultCapabilityService ? resolveDaemonCapabilityIdentity : undefined);
  return {
    ...toolDeps,
    // The stdio MCP process is intentionally a thin client of the
    // server-authoritative operation store. Keeping the executor in the main
    // daemon avoids splitting one install operation across two processes.
    capabilityService: toolDeps.capabilityService
      ?? (caller.serverId ? createServerCapabilityService({
        serverId: caller.serverId,
        activateSkill: async (capability) => {
          const identity = await resolveCapabilityIdentity!(caller);
          return identity
            ? activateCapabilitySkill(capability, {
                ownerId: identity.ownerId,
                namespace: identity.namespace,
                sessionId: identity.sessionId,
                projectDir: identity.projectDir,
                providerId: identity.providerId,
                serverId: identity.serverId,
              })
            : capabilityError('Current authenticated Skill activation context is unavailable');
        },
      }) : undefined),
    ...(resolveCapabilityIdentity ? { resolveCapabilityIdentity } : {}),
    peerAuditReply: toolDeps.peerAuditReply ?? (async (envelope) => {
      const port = await resolveLiveHookPort();
      if (!port) throw new Error('daemon peer audit ingress is unavailable');
      if (!caller.sessionName) throw new Error('peer_audit_reply requires a scoped caller');
      return postHookSend(port, envelope as unknown as Record<string, unknown>, '/audit-reply', caller.sessionName);
    }),
    delegationReply: toolDeps.delegationReply ?? (async (envelope) => {
      const port = await resolveLiveHookPort();
      if (!port) throw new Error('daemon delegation reply ingress is unavailable');
      if (!caller.sessionName) throw new Error('delegation_reply requires a scoped caller');
      return postHookSend(
        port,
        envelope as unknown as Record<string, unknown>,
        '/delegation-reply',
        caller.sessionName,
        DELEGATION_REPLY_HOOK_TIMEOUT_MS,
      );
    }),
    // FULL-node machine tools relay through the daemon's own bound credential.
    // An injected override (tests) wins; otherwise the daemon default is used.
    // This stdio MCP server only runs on FULL nodes, so the tools are advertised
    // (a controlled node never starts it — see registerMemoryMcpTools gate).
    machineDeps: toolDeps.machineDeps ?? createDaemonMachineToolDeps(),
    sendDeps: {
      ...toolDeps.sendDeps,
      // Production stdio MCP consults the daemon's static capability
      // advertisement for the execution-clone send/destroy gate instead of
      // defaulting to enabled. An explicitly-injected override (tests) wins —
      // the `??` is on the FUNCTION, so an injected fn returning `false` still
      // wins (we never fall back on a false RESULT, only an absent fn).
      isExecutionCloneCapabilityEnabled:
        toolDeps.sendDeps?.isExecutionCloneCapabilityEnabled
        ?? (() => isDaemonCapabilityAdvertised(EXECUTION_CLONE_CAPABILITY_V1)),
      // N2 (the standalone-MCP watershed): inject the run-authoritative limit
      // resolver so a model-driven `send_message.clone` on this stdio path
      // enforces the SAME tighter per-run limits the programmatic Team path
      // does — instead of always defaulting to cap=3/60min. Compose with any
      // explicitly-injected resolver (tests) rather than clobbering it; the
      // per-call `??` preserves the fallback even when an injected resolver
      // returns `undefined` for a given run. Keyed by the validated `parentRunId`.
      resolveExecutionCloneLimits: (parentRunId: string) =>
        toolDeps.sendDeps?.resolveExecutionCloneLimits?.(parentRunId)
        ?? resolveExecutionCloneLimitsForParentRun(parentRunId),
      // Per-field default: an injected `dispatchMessage` (tests) wins; otherwise
      // POST the daemon hook /send default.
      dispatchMessage:
        toolDeps.sendDeps?.dispatchMessage
        ?? (async (target: SessionRecord, message: string, options) => {
          const port = await resolveLiveHookPort();
          if (!port) throw new Error('daemon hook server is unavailable');
          if (!caller.sessionName) throw new Error('send_message requires a scoped caller');
          await postHookSend(port, {
            from: caller.sessionName,
            to: target.name,
            message,
            depth: 0,
            ...(options.deliveryMode ? { deliveryMode: options.deliveryMode } : {}),
          });
        }),
      // Per-field default: an injected `cancelSession` (tests) wins; otherwise
      // POST the daemon hook /stop default. Required so `send_stop` from this
      // stdio path force-stops a target instead of returning `internal_error`.
      cancelSession:
        toolDeps.sendDeps?.cancelSession
        ?? (async (target: SessionRecord) => {
          const port = await resolveLiveHookPort();
          if (!port) throw new Error('daemon hook server is unavailable');
          if (!caller.sessionName) throw new Error('send_stop requires a scoped caller');
          const res = await postHookSend(port, {
            from: caller.sessionName,
            to: target.name,
          }, '/stop');
          return (res as { stopped?: boolean }).stopped !== false;
        }),
    },
  };
}

export function createMemoryMcpServerFromEnv(options: MemoryMcpServerOptions = {}): McpServer {
  const caller = parseMcpRuntimeCallerFromEnv(options.env ?? process.env, 'stdio');
  return createMemoryMcpServer(
    caller,
    mergeDefaultToolDeps(caller, options.toolDeps ?? {}),
    options.messagePinToolDeps,
    options.supervisionToolDeps,
  );
}

export async function runMemoryMcpServer(options: MemoryMcpServerOptions = {}): Promise<void> {
  try {
    await loadStore();
    const server = createMemoryMcpServerFromEnv(options);
    await server.connect(new StdioServerTransport());
  } catch (err) {
    if (err instanceof MemoryMcpCallerEnvError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}
