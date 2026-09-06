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
import {
  registerAliasMcpTools,
  registerMemoryMcpTools,
  type AliasMcpToolDeps,
  type MemoryMcpToolDeps,
} from './memory-mcp-tools.js';
import { registerMessagePinMcpTools, type MessagePinMcpToolDeps } from './message-pin-mcp-tools.js';
import { registerSupervisionMcpTools, type SupervisionMcpToolDeps } from './supervision-mcp-tools.js';
import { createSupervisionMcpToolDeps } from './supervision-registry-port.js';
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
  CAPABILITY_ERROR,
  type CapabilityErrorResult,
} from '../../shared/capability-management.js';
import { registerMcpToolDiscovery } from './mcp-tool-discovery.js';
import { isMemoryScope, validateMemoryScopeIdentity } from '../../shared/memory-scope.js';
import type { ContextNamespace } from '../../shared/context-types.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES, MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { MEMORY_MCP_ENV_KEYS } from '../../shared/memory-mcp-env.js';
import { parseMcpToolCatalogMode, type McpToolCatalogMode } from '../../shared/mcp-tool-discovery.js';
import { MemoryMcpResourceGuard } from './memory-mcp-resource-guard.js';
import {
  TASK_ADMISSION,
  TASK_ADMISSION_HOOK_PATH,
  TASK_ADMISSION_OPERATION,
  MEMORY_MCP_WATCHDOG,
} from '../../shared/session-resource-lifecycle.js';
import {
  registerMcpProcessResource,
  releaseSessionResource,
  sessionResourceOwnerFromEnv,
} from './session-resource-service.js';
import type { SessionResourceOwner } from './session-resource-registry.js';
import { EMBEDDING_MODEL_RSS_BUDGET_BYTES } from '../../shared/embedding-config.js';
import {
  MEMORY_MCP_DAEMON_RPC_PATH,
  type MemoryMcpDaemonToolName,
} from '../../shared/memory-mcp-daemon-rpc.js';

export interface MemoryMcpServerOptions {
  env?: Record<string, string | undefined>;
  toolDeps?: MemoryMcpToolDeps;
  messagePinToolDeps?: MessagePinMcpToolDeps;
  /** Injected by tests; production binds the real registry. */
  supervisionToolDeps?: SupervisionMcpToolDeps;
  resourceGuard?: MemoryMcpResourceGuard;
}

export interface MemoryMcpServerCatalogOptions {
  toolCatalogMode?: McpToolCatalogMode;
  resourceGuard?: MemoryMcpResourceGuard;
  daemonAdmissionEnabled?: boolean;
  daemonAdmissionOwner?: SessionResourceOwner | null;
}

const MEMORY_MCP_DEFAULT_MAX_CONCURRENT = 8;
// The semantic-search path starts both the embedding and context-store workers
// after the stdio server baseline is measured. Budget the model explicitly and
// leave room for the second worker, SQLite/native allocations, and result data.
// The old model-only 768 MiB allowance made a healthy first search kill MCP.
const MEMORY_MCP_NON_MODEL_RSS_HEADROOM_BYTES = 512 * 1024 * 1024;
const MEMORY_MCP_DEFAULT_RSS_HEADROOM_BYTES =
  EMBEDDING_MODEL_RSS_BUDGET_BYTES + MEMORY_MCP_NON_MODEL_RSS_HEADROOM_BYTES;
const MEMORY_MCP_DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function positiveEnvNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The embedding worker shares this process' RSS but platform/loader baseline
 * RSS differs substantially. Bound memory growth, rather than comparing the
 * post-search process against an absolute budget smaller than a valid x64
 * baseline plus the model.
 */
export function resolveMemoryMcpMaxRssBytes(
  env: Record<string, string | undefined> = process.env,
  baselineRssBytes = process.memoryUsage().rss,
): number {
  const baseline = Number.isFinite(baselineRssBytes) && baselineRssBytes >= 0
    ? baselineRssBytes
    : 0;
  return positiveEnvNumber(
    env.IMCODES_MEMORY_MCP_MAX_RSS_BYTES,
    baseline + MEMORY_MCP_DEFAULT_RSS_HEADROOM_BYTES,
  );
}

function createDefaultMemoryMcpResourceGuard(
  env: Record<string, string | undefined> = process.env,
  onSustainedCpu?: (details: { cpuRatio: number; strikes: number }) => void,
): MemoryMcpResourceGuard {
  return new MemoryMcpResourceGuard({
    maxConcurrent: positiveEnvNumber(env.IMCODES_MEMORY_MCP_MAX_CONCURRENT, MEMORY_MCP_DEFAULT_MAX_CONCURRENT),
    maxRssBytes: resolveMemoryMcpMaxRssBytes(env),
    requestTimeoutMs: positiveEnvNumber(env.IMCODES_MEMORY_MCP_REQUEST_TIMEOUT_MS, MEMORY_MCP_DEFAULT_REQUEST_TIMEOUT_MS),
    cpuStrikeLimit: MEMORY_MCP_WATCHDOG.CPU_STRIKE_LIMIT,
    onSustainedCpu,
  });
}

/**
 * Tools whose resource use is ACCOUNTED FOR, never gated.
 *
 * These two are how the supervision control plane hands out work. Putting a
 * memory-pressure check in front of them meant a memory incident made itself
 * both undiagnosable and unfixable: the plane could not dispatch the task to
 * investigate the pressure, because the pressure refused the dispatch. A
 * resource signal is worth recording; it is not a reason to withhold the
 * remedy. Admission is therefore observed and reported, and it never blocks.
 */
const DAEMON_ADMISSION_ACCOUNTED_TOOLS = new Set<string>([
  MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START,
]);

/** Record-only outcomes. Exported so tests bind to these and never re-spell them. */
export const DAEMON_TASK_ADMISSION_OUTCOME = {
  ACCEPTED: 'accepted',
  PRESSURE_OBSERVED: 'pressure_observed',
  IDENTITY_UNAVAILABLE: 'identity_unavailable',
  UNAVAILABLE: 'unavailable',
} as const;

export type DaemonTaskAdmissionOutcome =
  typeof DAEMON_TASK_ADMISSION_OUTCOME[keyof typeof DAEMON_TASK_ADMISSION_OUTCOME];

/** Test seam: observe what the gate WOULD have done, without it doing anything. */
let daemonTaskAdmissionObserver:
  ((record: { tool: string; outcome: DaemonTaskAdmissionOutcome; detail?: string }) => void) | null = null;

export function __setDaemonTaskAdmissionObserverForTests(
  observer: ((record: { tool: string; outcome: DaemonTaskAdmissionOutcome; detail?: string }) => void) | null,
): void {
  daemonTaskAdmissionObserver = observer;
}

function recordDaemonTaskAdmission(
  tool: string,
  outcome: DaemonTaskAdmissionOutcome,
  detail?: string,
): void {
  daemonTaskAdmissionObserver?.({ tool, outcome, ...(detail ? { detail } : {}) });
  if (outcome === DAEMON_TASK_ADMISSION_OUTCOME.ACCEPTED) return;
  // stderr, because stdout is the MCP protocol channel.
  process.stderr.write(
    `[memory-mcp] task admission ${outcome} for ${tool}${detail ? `: ${detail}` : ''}; proceeding (record-only)\n`,
  );
}

/**
 * Take an admission lease if one is immediately available.
 *
 * One attempt, no retry loop, no throw. The previous implementation polled for
 * five seconds and then threw `daemon_task_memory_budget_rejected` or
 * `daemon_task_memory_budget_queued`, which both refused the call and added up
 * to five seconds of latency to every dispatch. A lease is still taken and
 * released when the daemon grants one, so accounting stays honest whenever it
 * is available; when it is not, the caller proceeds regardless.
 */
async function observeDaemonTaskAdmission(
  tool: string,
  caller: McpRuntimeCaller,
  owner: SessionResourceOwner | null,
): Promise<{ port: number; token: string } | null> {
  if (!caller.sessionName || !owner || owner.sessionName !== caller.sessionName) {
    recordDaemonTaskAdmission(tool, DAEMON_TASK_ADMISSION_OUTCOME.IDENTITY_UNAVAILABLE);
    return null;
  }
  try {
    const port = await resolveLiveHookPort();
    if (!port) {
      recordDaemonTaskAdmission(tool, DAEMON_TASK_ADMISSION_OUTCOME.UNAVAILABLE, 'no_hook_port');
      return null;
    }
    const response = await postHookSend(
      port,
      {
        operation: TASK_ADMISSION_OPERATION.ACQUIRE,
        sessionInstanceId: owner.sessionInstanceId,
        runtimeEpoch: owner.runtimeEpoch,
      },
      TASK_ADMISSION_HOOK_PATH,
      caller.sessionName,
      2_000,
    );
    if (response.action === TASK_ADMISSION.ACCEPT && typeof response.token === 'string') {
      recordDaemonTaskAdmission(tool, DAEMON_TASK_ADMISSION_OUTCOME.ACCEPTED);
      return { port, token: response.token };
    }
    // Pressure is real and recorded. It still does not refuse the call.
    recordDaemonTaskAdmission(
      tool, DAEMON_TASK_ADMISSION_OUTCOME.PRESSURE_OBSERVED, String(response.action ?? 'unknown'),
    );
    return null;
  } catch (error) {
    // Even a broken admission hook must not take the control plane with it.
    recordDaemonTaskAdmission(
      tool, DAEMON_TASK_ADMISSION_OUTCOME.UNAVAILABLE,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

async function releaseDaemonTaskAdmission(
  caller: McpRuntimeCaller,
  owner: SessionResourceOwner | null,
  lease: { port: number; token: string } | null,
): Promise<void> {
  if (!lease || !caller.sessionName || !owner) return;
  await postHookSend(
    lease.port,
    {
      operation: TASK_ADMISSION_OPERATION.RELEASE,
      token: lease.token,
      sessionInstanceId: owner.sessionInstanceId,
      runtimeEpoch: owner.runtimeEpoch,
    },
    TASK_ADMISSION_HOOK_PATH,
    caller.sessionName,
    2_000,
  ).catch(() => {});
}

function installMemoryMcpResourceGuard(
  server: McpServer,
  caller: McpRuntimeCaller,
  guard: MemoryMcpResourceGuard,
  daemonAdmissionEnabled: boolean,
  daemonAdmissionOwner: SessionResourceOwner | null,
): void {
  const original = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, callback: (...args: unknown[]) => unknown) => {
    const guarded = async (...args: unknown[]) => guard.run(name, async () => {
      const lease = daemonAdmissionEnabled && DAEMON_ADMISSION_ACCOUNTED_TOOLS.has(name)
        ? await observeDaemonTaskAdmission(name, caller, daemonAdmissionOwner)
        : null;
      try {
        return await callback(...args);
      } finally {
        await releaseDaemonTaskAdmission(caller, daemonAdmissionOwner, lease);
      }
    });
    return original(
      name,
      config as Parameters<typeof original>[1],
      guarded as Parameters<typeof original>[2],
    );
  }) as typeof server.registerTool;
}

type ExactStoreMcpToolDeps = MessagePinMcpToolDeps & AliasMcpToolDeps;

export function createMemoryMcpServer(
  caller: McpRuntimeCaller,
  toolDeps: MemoryMcpToolDeps = {},
  exactStoreToolDeps: ExactStoreMcpToolDeps = {},
  supervisionToolDeps: SupervisionMcpToolDeps = {},
  catalogOptions: MemoryMcpServerCatalogOptions = {},
): McpServer {
  const server = new McpServer({
    name: IMCODES_MEMORY_MCP_SERVER_NAME,
    version: '0.1.0',
  });
  if (caller.transport === 'stdio') {
    installMemoryMcpResourceGuard(
      server,
      caller,
      catalogOptions.resourceGuard ?? createDefaultMemoryMcpResourceGuard(),
      catalogOptions.daemonAdmissionEnabled === true,
      catalogOptions.daemonAdmissionOwner ?? null,
    );
  }
  const registered = new Map([
    ...registerMemoryMcpTools(server, caller, toolDeps),
    ...registerCapabilityMcpTools(server, caller, toolDeps),
  ]);
  // Exact server-backed stores share this MCP server surface but stay outside
  // the fuzzy-memory contract list and schema firewall.
  for (const [name, tool] of registerAliasMcpTools(server, caller, exactStoreToolDeps)) registered.set(name, tool);
  for (const [name, tool] of registerMessagePinMcpTools(server, caller, exactStoreToolDeps)) registered.set(name, tool);
  // Supervision registry: exact server-backed operations, same separation as
  // alias/message-pin tools -- outside the fuzzy-memory contract + firewall.
  for (const [name, tool] of registerSupervisionMcpTools(server, caller, supervisionToolDeps)) registered.set(name, tool);
  registerMcpToolDiscovery(server, registered, { catalogMode: catalogOptions.toolCatalogMode });
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
export function mergeDefaultToolDeps(
  caller: McpRuntimeCaller,
  toolDeps: MemoryMcpToolDeps,
  resourceOwner: SessionResourceOwner | null = sessionResourceOwnerFromEnv(),
): MemoryMcpToolDeps {
  const usesDefaultCapabilityService = !toolDeps.capabilityService && Boolean(caller.serverId);
  const resolveCapabilityIdentity = toolDeps.resolveCapabilityIdentity
    ?? (usesDefaultCapabilityService ? resolveDaemonCapabilityIdentity : undefined);
  return {
    ...toolDeps,
    invokeDaemonMemoryTool: toolDeps.invokeDaemonMemoryTool
      ?? (resourceOwner && caller.sessionName
        ? async (name: MemoryMcpDaemonToolName, input?: unknown) => {
            const port = await resolveLiveHookPort();
            if (!port) throw new Error('daemon_memory_worker_unavailable');
            const response = await postHookSend(port, {
              sessionInstanceId: resourceOwner.sessionInstanceId,
              runtimeEpoch: resourceOwner.runtimeEpoch,
              serverId: caller.serverId,
              tool: name,
              input,
            }, MEMORY_MCP_DAEMON_RPC_PATH, caller.sessionName!, MEMORY_MCP_DEFAULT_REQUEST_TIMEOUT_MS);
            const result = response.result;
            if (!result || typeof result !== 'object' || Array.isArray(result)) {
              throw new Error('daemon_memory_worker_invalid_response');
            }
            return result as Record<string, unknown>;
          }
        : undefined),
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
    machineDeps: toolDeps.machineDeps ?? createDaemonMachineToolDeps({ resourceOwner }),
    sendDeps: {
      ...toolDeps.sendDeps,
      // The stdio MCP runs in a child process, so its local transport/tmux
      // maps cannot prove whether a session omitted by a sessions.json refresh
      // is still alive. Query the main daemon's authoritative directory once
      // instead of turning a transient omission into `target not found`.
      isSessionAuthoritativelyActive:
        toolDeps.sendDeps?.isSessionAuthoritativelyActive
        ?? (async (candidate: SessionRecord) => {
          const port = await resolveLiveHookPort();
          if (!port) return false;
          try {
            const response = await postHookSend(port, {}, '/sessions/live', caller.sessionName ?? undefined, 2_000);
            const sessions = Array.isArray(response.sessions) ? response.sessions : [];
            const current = sessions.find((entry) => (
              entry && typeof entry === 'object'
              && (entry as { name?: unknown }).name === candidate.name
            )) as { state?: unknown } | undefined;
            return Boolean(current && current.state !== 'stopped' && current.state !== 'error');
          } catch {
            return false;
          }
        }),
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
          const response = await postHookSend(port, {
            from: caller.sessionName,
            to: target.name,
            message,
            depth: 0,
            ...(options.deliveryMode ? { deliveryMode: options.deliveryMode } : {}),
            ...(options.supervision ? {
              supervision: options.supervision,
              messageId: options.messageId,
            } : {}),
          });
          return response.queued === true ? 'queued' : 'sent';
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
  const env = options.env ?? process.env;
  const caller = parseMcpRuntimeCallerFromEnv(env, 'stdio');
  const admissionOwner = sessionResourceOwnerFromEnv(env as NodeJS.ProcessEnv);
  return createMemoryMcpServer(
    caller,
    mergeDefaultToolDeps(caller, options.toolDeps ?? {}, admissionOwner),
    options.messagePinToolDeps,
    // Fourth argument was MISSING, so supervisionToolDeps defaulted to {} and
    // every supervision tool reported `supervision registry not bound`.
    options.supervisionToolDeps ?? createSupervisionMcpToolDeps(),
    {
      toolCatalogMode: parseMcpToolCatalogMode(env[MEMORY_MCP_ENV_KEYS.TOOL_CATALOG_MODE]),
      resourceGuard: options.resourceGuard,
      daemonAdmissionEnabled: Boolean(
        admissionOwner && admissionOwner.sessionName === caller.sessionName,
      ),
      daemonAdmissionOwner: admissionOwner,
    },
  );
}

export async function runMemoryMcpServer(options: MemoryMcpServerOptions = {}): Promise<void> {
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await loadStore();
    const env = options.env ?? process.env;
    let cpuShutdownStarted = false;
    let server: McpServer;
    const guard = createDefaultMemoryMcpResourceGuard(env, ({ cpuRatio, strikes }) => {
      process.stderr.write(`[memory-mcp] sustained single-core CPU: ratio=${cpuRatio.toFixed(2)} strikes=${strikes}; restarting\n`);
      if (cpuShutdownStarted) return;
      cpuShutdownStarted = true;
      void server.close().finally(() => process.exit(70));
    });
    server = createMemoryMcpServerFromEnv({ ...options, resourceGuard: guard });
    const owner = sessionResourceOwnerFromEnv(env as NodeJS.ProcessEnv);
    const resourceId = owner ? await registerMcpProcessResource(owner) : null;
    let previousCpu = process.cpuUsage();
    let previousWall = Date.now();
    const cpuTimer = setInterval(() => {
      const now = Date.now();
      const usage = process.cpuUsage(previousCpu);
      guard.observeCpuWindow(usage.user + usage.system, now - previousWall);
      if (guard.memoryLimitExceeded() && !cpuShutdownStarted) {
        cpuShutdownStarted = true;
        process.stderr.write('[memory-mcp] process RSS budget exceeded; restarting\n');
        void server.close().finally(() => process.exit(71));
      }
      previousCpu = process.cpuUsage();
      previousWall = now;
    }, MEMORY_MCP_WATCHDOG.SAMPLE_INTERVAL_MS);
    cpuTimer.unref?.();
    const activeCleanup = async () => {
      clearInterval(cpuTimer);
      if (owner && resourceId) await releaseSessionResource(resourceId, owner).catch(() => {});
    };
    cleanup = activeCleanup;
    process.once('beforeExit', () => { void activeCleanup(); });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void activeCleanup().finally(() => server.close()).finally(() => process.exit(0));
      });
    }
    await server.connect(new StdioServerTransport());
  } catch (err) {
    await cleanup?.();
    if (err instanceof MemoryMcpCallerEnvError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}
