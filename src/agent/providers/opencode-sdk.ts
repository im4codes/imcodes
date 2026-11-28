import { ProviderStopConfirmation } from '../provider-stop-confirmation.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { OpenCodeEvent } from '@opencode/sdk';
import type {
  ApprovalRequest,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderModelList,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  RemoteSessionInfo,
  RemoteSessionListOptions,
  SessionConfig,
  SessionInfoUpdate,
  ToolExecutionGuard,
  TransportProvider,
  ProviderDelegationNotification,
  ProviderCancelOptions,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  PROVIDER_CANCEL_ORIGINS,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { MEMORY_MCP_STATUS, type MemoryMcpProviderStatusView } from '../../../shared/memory-ws.js';
import { isTransientRequestFailure } from '../../../shared/request-failure.js';
import {
  CRON_CONTROL_PROTOCOL,
  isCronSilentResult,
} from '../../../shared/cron-types.js';
import { composeProviderSystemText } from '../provider-context-routing.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import logger from '../../util/logger.js';
import { imcodesStatePath } from '../../util/imcodes-state-dir.js';
import {
  OPENCODE_TRANSPORT_MODES,
  compareOpenCodeSessionSnapshots,
  inspectOpenCodeSqliteSession,
  inspectOpenCodeSqliteSessions,
  isLoopbackHostname,
  redactSecretText,
  resolveOpenCodeTransport,
  startOpenCodeV2CliHost,
  type OpenCodeTransportResolution,
} from './opencode-cli.js';
import { OpenCodeV1CliProvider } from './opencode-v1-compat.js';
import { NativeAgentFenceSlot, OPENCODE_NATIVE_AGENT_TOOLS, fenceOf } from '../native-agent-fence.js';
import {
  NATIVE_AGENT_ADMISSION_MODES,
  NATIVE_AGENT_FENCES,
  type NativeAgentFence,
} from '../../../shared/native-collaboration-policy.js';
import type { NativeAgentFenceResolver } from '../transport-provider.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';
import type { InteractiveQuestionAnswerer } from '../pending-question-registry.js';
import {
  parseAskQuestionAnswers,
  type AskQuestionItem,
} from '../../../shared/ask-question-normalize.js';
import { INTERACTIVE_QUESTION_TOOL_NAME } from '../../../shared/codex-user-input.js';
import {
  OPENCODE_SDK_EFFORT_LEVELS,
  clampTransportEffort,
  normalizeSupportedEffortLevels,
  type TransportEffortLevel,
} from '../../../shared/effort-levels.js';
import {
  SESSION_CONTROL_METADATA_COMMAND_FIELD,
  isSessionControlCommandText,
} from '../../../shared/session-control-commands.js';
import { DEFAULT_OPENCODE_MODEL_ID } from '../../shared/models/options.js';

const LOOPBACK_HOST = '127.0.0.1';
const MODEL_CACHE_TTL_MS = 30_000;
const PLUGIN_WARMUP_MAX_WAIT_MS = 4_000;
const PLUGIN_WARMUP_POLL_MS = 75;
// OpenCode loads its models.dev catalog (including each model's `limit.context`)
// asynchronously after an OpenCode host starts. A session created in that window
// primes the model→context-window map from a catalog that still lacks limits,
// so usage frames ship without an authoritative window and the UI falls back to
// a 1M guess. When a live usage frame can't resolve its model's window we force
// one throttled catalog refetch so the next frame self-heals.
const CONTEXT_WINDOW_REFRESH_MIN_INTERVAL_MS = 3_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;
const PROMPT_ACCEPTANCE_RECHECK_DELAYS_MS = [0, 100, 250, 500, 1_000] as const;
const MISSING_FINAL_RECOVERY_TIMEOUT_MS = 15_000;
const INTERRUPT_RPC_TIMEOUT_MS = 150;
const CHILD_CLOSE_TIMEOUT_MS = 2_000;
const MISSING_FINAL_RECOVERY_RECHECK_DELAYS_MS = [250, 1_000] as const;
const RETRY_TERMINAL_RECONCILE_DELAYS_MS = [0, 25, 75, 200, 500] as const;
const IMCODES_SYSTEM_INSTRUCTION_KEY = 'imcodes-system';
type PromptAcceptance = 'accepted' | 'absent' | 'unknown';
const OPENCODE_PERMISSION_EVENT = {
  ASKED: 'permission.asked',
  V2_ASKED: 'permission.v2.asked',
  LEGACY_UPDATED: 'permission.updated',
} as const;
const MISSING_FINAL_RECOVERY_PROMPT = [
  'The previous tool step finished, but you returned no final response.',
  "Continue from the existing results and answer the user's original request now.",
  'Do not repeat completed tool calls unless the existing result is insufficient.',
].join(' ');

export interface OpenCodeSessionPermissionRuleLike {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

export interface OpenCodeSessionInfoLike {
  id: string;
  title?: string;
  location?: { directory?: string };
  permissions?: OpenCodeSessionPermissionRuleLike[];
  time?: { created?: number; updated?: number };
}

export interface OpenCodeProviderInfoLike {
  id: string;
  name?: string;
  activation?: string;
}

export interface OpenCodeModelInfoLike {
  id?: string;
  modelID: string;
  providerID: string;
  name?: string;
  enabled?: boolean;
  type?: string;
  limit?: { context?: number; output?: number };
  variants?: Array<{ id?: string; name?: string; disabled?: boolean }>;
  capabilities?: { reasoning?: boolean };
}

export interface OpenCodeClientLike {
  sessions: {
    create(input: {
      location: { directory: string };
      title?: string;
      permissions?: OpenCodeSessionPermissionRuleLike[];
    }): Promise<OpenCodeSessionInfoLike>;
    get(input: { sessionID: string }): Promise<OpenCodeSessionInfoLike>;
    prompt(input: Record<string, unknown>, requestOptions?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  };
  session: {
    list(input?: { directory?: string }): Promise<{ data?: OpenCodeSessionInfoLike[]; cursor?: unknown }>;
    update?(input: {
      sessionID: string;
      title?: string;
      metadata?: Record<string, unknown>;
      permissions?: OpenCodeSessionPermissionRuleLike[];
      archived?: boolean;
    }): Promise<void>;
    switchModel(input: {
      sessionID: string;
      model: { providerID: string; id: string; variant?: string };
    }): Promise<void>;
    compact(input: { sessionID: string; id?: string }, requestOptions?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
    interrupt(input: { sessionID: string }): Promise<{ interrupted?: boolean } | void>;
    active?(): Promise<Record<string, unknown>>;
    inbox?: {
      list(input: { sessionID: string }): Promise<Array<Record<string, unknown>> | { data?: Array<Record<string, unknown>> }>;
      cancel?(input: { sessionID: string; inboxID: string }): Promise<void>;
    };
    message: {
      get(input: { sessionID: string; messageID: string }): Promise<Record<string, unknown>>;
    };
    form?: {
      reply(input: {
        sessionID: string;
        formID: string;
        answer: Record<string, string | number | boolean | string[]>;
      }): Promise<void>;
      cancel(input: { sessionID: string; formID: string }): Promise<void>;
    };
  };
  message: {
    list(input: {
      sessionID: string;
      limit?: number;
      order?: 'asc' | 'desc';
    }): Promise<{ data?: Array<Record<string, unknown>>; cursor?: unknown }>;
  };
  model: {
    list(input?: { location?: { directory?: string } }): Promise<{ data?: OpenCodeModelInfoLike[] }>;
    default(input?: { location?: { directory?: string } }): Promise<{ data?: OpenCodeModelInfoLike | null }>;
  };
  provider: {
    list(input?: { location?: { directory?: string } }): Promise<{ data?: OpenCodeProviderInfoLike[] }>;
  };
  permission: {
    reply(input: {
      sessionID: string;
      requestID: string;
      decision: 'once' | 'always' | 'reject';
    }): Promise<void>;
  };
  events: {
    subscribe(
      options?: Record<string, unknown>,
      requestOptions?: { signal?: AbortSignal },
    ): AsyncIterable<OpenCodeEvent | Record<string, unknown>> | Promise<AsyncIterable<OpenCodeEvent | Record<string, unknown>> | { stream: AsyncIterable<OpenCodeEvent | Record<string, unknown>> }>;
  };
  experimental?: {
    session?: {
      instructions?: {
        entry?: {
          put(input: { sessionID: string; key: string; value: string }): Promise<void>;
          remove(input: { sessionID: string; key: string }): Promise<void>;
        };
      };
      wait?(input: { sessionID: string }): Promise<void>;
      import?(input: Record<string, unknown>): Promise<OpenCodeSessionInfoLike>;
    };
    mcp?: {
      add?(input: {
        server: string;
        location?: { directory?: string };
        config: Record<string, unknown>;
      }): Promise<void>;
      remove?(input: {
        server: string;
        location?: { directory?: string };
      }): Promise<void>;
    };
  };
  plugin?: {
    list(input?: { location?: { directory?: string } }): Promise<{ data?: Array<Record<string, unknown>> }>;
  };
  credential?: {
    list(): Promise<Array<{ id: string; integrationID: string; label?: string; active?: boolean }>>;
    remove(input: { credentialID: string }): Promise<void>;
  };
  close?: () => Promise<void> | void;
}

interface OpenCodeServerLike {
  url: string;
  close(): Promise<void> | void;
}

export interface OpenCodeMcpServerSpec {
  type: 'local';
  command: string[];
  environment: Record<string, string>;
  disabled: boolean;
}

export interface OpenCodeSdkStartOptions {
  hostname: string;
  port: number;
  timeout: number;
  signal: AbortSignal;
  config?: Record<string, unknown>;
  databasePath?: string;
  directory?: string;
  warmupCatalog?: boolean;
  hostGroupKey?: string;
  mcpServers?: Record<string, OpenCodeMcpServerSpec>;
}

export interface OpenCodeSdkRuntimeStartResult {
  client: OpenCodeClientLike;
  server: OpenCodeServerLike;
  subscribeEvents?: (
    consumerId: symbol,
    listener: (event: Record<string, any>) => void,
    onError: (error: unknown) => void,
  ) => Promise<() => Promise<void>>;
  ensureEvents?: () => Promise<void>;
  bindSessionMcp?: (
    providerSessionId: string,
    directory: string,
    mcpServers: Record<string, OpenCodeMcpServerSpec>,
  ) => Promise<void>;
  unbindSessionMcp?: (providerSessionId: string) => Promise<void>;
}

export interface OpenCodeSdkRuntimeHooks {
  start(options: OpenCodeSdkStartOptions): Promise<OpenCodeSdkRuntimeStartResult>;
}

interface McpToolDescriptor {
  serverName: string;
  toolName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

interface BoundSessionMcpServer {
  serverName: string;
  signature: string;
  client: {
    callTool(
      params: { name: string; arguments: Record<string, unknown> },
      resultSchema?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<{
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type: string; text?: string; mimeType?: string; data?: string; uri?: string }>;
    }>;
    close(): Promise<void>;
  };
  transport: { close(): Promise<void> };
  tools: McpToolDescriptor[];
}

function normalizeOpenCodeMcpNamespace(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp';
}

function normalizeOpenCodeMcpToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
}

function sanitizeMcpInputSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  return { type: 'object', properties: {} };
}

function formatMcpToolResult(result: Awaited<ReturnType<BoundSessionMcpServer['client']['callTool']>>): {
  output: unknown;
  content?: Array<{ type: 'text'; text: string }>;
} {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const textParts = parts
    .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => ({ type: 'text' as const, text: part.text }));
  const text = textParts.map((part) => part.text).join('\n');
  if (result?.isError) {
    throw new Error(text.trim() || 'MCP tool returned an error');
  }
  let output: unknown = text === '' ? null : text;
  if (result?.structuredContent !== undefined) {
    output = result.structuredContent;
  } else if (text.startsWith('{') || text.startsWith('[')) {
    try {
      output = JSON.parse(text);
    } catch {
      output = text;
    }
  }
  return {
    output,
    ...(textParts.length > 0 ? { content: textParts } : {}),
  };
}

class SharedOpenCodeHostMcpCoordinator {
  private readonly sessionBindings = new Map<string, {
    directory: string;
    servers: Map<string, BoundSessionMcpServer>;
  }>();
  private readonly directoryReloaders = new Map<string, Set<() => Promise<void>>>();

  readonly plugin = {
    id: 'imcodes-session-mcp',
    setup: (ctx: {
      location: { directory: string };
      tool: {
        transform: (fn: (editor: {
          add: (tool: Record<string, unknown>) => void;
        }) => void) => void;
        reload: () => Promise<void>;
      };
      session: {
        hook: (event: string, fn: (request: {
          sessionID: string;
          tools: Record<string, unknown>;
        }) => void | Promise<void>) => void;
      };
    }) => {
      const dirKey = resolve(ctx.location.directory);
      const reloader = () => ctx.tool.reload().catch(() => {});
      let reloaders = this.directoryReloaders.get(dirKey);
      if (!reloaders) {
        reloaders = new Set();
        this.directoryReloaders.set(dirKey, reloaders);
      }
      reloaders.add(reloader);

      ctx.tool.transform((editor) => {
        const deduped = new Map<string, McpToolDescriptor>();
        for (const binding of this.sessionBindings.values()) {
          if (binding.directory !== dirKey) continue;
          for (const server of binding.servers.values()) {
            for (const tool of server.tools) {
              const key = `${normalizeOpenCodeMcpNamespace(tool.serverName)}\0${normalizeOpenCodeMcpToolName(tool.toolName)}`;
              if (!deduped.has(key)) deduped.set(key, tool);
            }
          }
        }
        for (const tool of deduped.values()) {
          const namespace = normalizeOpenCodeMcpNamespace(tool.serverName);
          editor.add({
            name: tool.toolName,
            options: { namespace, codemode: false },
            description: tool.description ?? '',
            input: tool.inputSchema,
            output: tool.outputSchema ?? { type: 'object' },
            execute: async (input: unknown, toolContext: { sessionID: string; signal?: AbortSignal }) => {
              const bound = this.resolveBoundServer(toolContext.sessionID, tool.serverName, tool.toolName);
              if (!bound) {
                throw new Error(`MCP server "${tool.serverName}" tool "${tool.toolName}" is not bound to session ${toolContext.sessionID}`);
              }
              const result = await bound.client.callTool(
                { name: tool.toolName, arguments: (input && typeof input === 'object' ? input : {}) as Record<string, unknown> },
                undefined,
                toolContext.signal ? { signal: toolContext.signal } : undefined,
              );
              return formatMcpToolResult(result);
            },
          });
        }
      });

      ctx.session.hook('context', (request) => {
        const sessionBinding = this.sessionBindings.get(request.sessionID);
        const managedNames = new Set<string>();
        const allowedNames = new Set<string>();
        for (const [sid, binding] of this.sessionBindings.entries()) {
          if (binding.directory !== dirKey) continue;
          for (const server of binding.servers.values()) {
            const ns = normalizeOpenCodeMcpNamespace(server.serverName);
            for (const tool of server.tools) {
              const fullName = `${ns}_${normalizeOpenCodeMcpToolName(tool.toolName)}`;
              managedNames.add(fullName);
              if (sid === request.sessionID || (sessionBinding && sessionBinding.servers.has(server.serverName))) {
                allowedNames.add(fullName);
              }
            }
          }
        }
        for (const toolName of managedNames) {
          if (!allowedNames.has(toolName)) {
            delete request.tools[toolName];
          }
        }
      });

      return () => {
        reloaders?.delete(reloader);
        if (reloaders && reloaders.size === 0) {
          this.directoryReloaders.delete(dirKey);
        }
      };
    },
  };

  private resolveBoundServer(providerSessionId: string, serverName: string, toolName: string): BoundSessionMcpServer | undefined {
    const binding = this.sessionBindings.get(providerSessionId);
    if (!binding) return undefined;
    const server = binding.servers.get(serverName);
    if (!server) return undefined;
    return server.tools.some((tool) => tool.toolName === toolName) ? server : undefined;
  }

  private async reloadDirectory(dirKey: string): Promise<void> {
    const reloaders = this.directoryReloaders.get(dirKey);
    if (!reloaders || reloaders.size === 0) return;
    await Promise.all([...reloaders].map((fn) => fn()));
  }

  async bindSession(
    providerSessionId: string,
    directory: string,
    mcpServers: Record<string, OpenCodeMcpServerSpec>,
  ): Promise<void> {
    const dirKey = resolve(directory);
    const existing = this.sessionBindings.get(providerSessionId);
    const nextServers = new Map<string, BoundSessionMcpServer>();
    const toClose: BoundSessionMcpServer[] = [];

    if (existing) {
      for (const [serverName, bound] of existing.servers.entries()) {
        const nextSpec = mcpServers[serverName];
        if (!nextSpec || nextSpec.disabled || JSON.stringify(nextSpec) !== bound.signature) {
          toClose.push(bound);
        } else {
          nextServers.set(serverName, bound);
        }
      }
    }

    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);

    for (const [serverName, spec] of Object.entries(mcpServers)) {
      if (spec.disabled || nextServers.has(serverName) || !Array.isArray(spec.command) || spec.command.length === 0) {
        continue;
      }
      const signature = JSON.stringify(spec);
      const [command, ...args] = spec.command;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') env[k] = v;
      }
      for (const [k, v] of Object.entries(spec.environment ?? {})) {
        if (typeof v === 'string') env[k] = v;
      }
      const transport = new StdioClientTransport({
        command,
        args,
        env,
        cwd: dirKey,
        stderr: 'pipe',
      });
      const client = new Client({ name: 'imcodes-opencode-mcp', version: '1.0.0' });
      try {
        await withOpenCodeRequestTimeout(client.connect(transport), `MCP connect (${serverName})`);
        const listed = await withOpenCodeRequestTimeout(client.listTools(), `MCP listTools (${serverName})`);
        const tools: McpToolDescriptor[] = (Array.isArray(listed?.tools) ? listed.tools : []).map((tool) => ({
          serverName,
          toolName: String(tool.name),
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          inputSchema: sanitizeMcpInputSchema(tool.inputSchema),
        }));
        nextServers.set(serverName, {
          serverName,
          signature,
          client: client as unknown as BoundSessionMcpServer['client'],
          transport,
          tools,
        });
      } catch (error) {
        await Promise.resolve(client.close()).catch(() => {});
        await Promise.resolve(transport.close()).catch(() => {});
        logger.warn({ provider: 'opencode-sdk', providerSessionId, serverName, directory: dirKey, error }, 'OpenCode session MCP startup failed');
      }
    }

    for (const old of toClose) {
      await Promise.resolve(old.client.close()).catch(() => {});
      await Promise.resolve(old.transport.close()).catch(() => {});
    }

    if (nextServers.size === 0) {
      this.sessionBindings.delete(providerSessionId);
    } else {
      this.sessionBindings.set(providerSessionId, { directory: dirKey, servers: nextServers });
    }
    await this.reloadDirectory(dirKey);
  }

  async unbindSession(providerSessionId: string): Promise<void> {
    const existing = this.sessionBindings.get(providerSessionId);
    if (!existing) return;
    this.sessionBindings.delete(providerSessionId);
    for (const bound of existing.servers.values()) {
      await Promise.resolve(bound.client.close()).catch(() => {});
      await Promise.resolve(bound.transport.close()).catch(() => {});
    }
    await this.reloadDirectory(existing.directory);
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessionBindings.keys()];
    await Promise.all(ids.map((id) => this.unbindSession(id)));
  }
}

interface SharedOpenCodeHostEntry {
  key: string;
  instance: Awaited<ReturnType<typeof import('@opencode/sdk')['OpenCode']['create']>>;
  mcpCoordinator: SharedOpenCodeHostMcpCoordinator;
  eventConsumers: Map<symbol, {
    listener: (event: Record<string, any>) => void;
    onError: (error: unknown) => void;
  }>;
  eventAbort: AbortController | null;
  eventLoop: Promise<void> | null;
  eventStartPromise: Promise<void> | null;
  refCount: number;
  closed: boolean;
  closePromise: Promise<void> | null;
}

const sharedOpenCodeHosts = new Map<string, SharedOpenCodeHostEntry>();
const sharedOpenCodeHostLocks = new Map<string, Promise<void>>();

async function withSharedHostLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sharedOpenCodeHostLocks.get(key) ?? Promise.resolve();
  let releaseLock!: () => void;
  const gate = new Promise<void>((resolveLock) => {
    releaseLock = resolveLock;
  });
  const chained = prev.catch(() => {}).then(() => gate);
  sharedOpenCodeHostLocks.set(key, chained);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    releaseLock();
    if (sharedOpenCodeHostLocks.get(key) === chained) {
      sharedOpenCodeHostLocks.delete(key);
    }
  }
}

function buildSanitizedSharedHostConfig(rawConfig: Record<string, unknown> | undefined): string | undefined {
  if (!rawConfig) return undefined;
  // Never bake single-session `mcp` or `permissions` into a shared embedded host config:
  // permissions are scoped per session via `sessions.create`/`session.update` and MCP
  // servers are registered per directory via `experimental.mcp.add`.
  const filtered = Object.fromEntries(
    Object.entries(rawConfig).filter(([key]) => key !== 'mcp' && key !== 'permissions'),
  );
  if (Object.keys(filtered).length === 0) return undefined;
  return JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...filtered });
}

export async function applyOpenCodeDirectoryMcpServers(
  client: OpenCodeClientLike,
  directory: string | undefined,
  mcpServers: Record<string, OpenCodeMcpServerSpec | Record<string, unknown>> | undefined,
): Promise<void> {
  const add = client.experimental?.mcp?.add;
  if (!add || !directory || !mcpServers) return;
  for (const [server, serverConfig] of Object.entries(mcpServers)) {
    try {
      await add({ server, location: { directory }, config: { ...serverConfig } });
    } catch (error) {
      logger.warn({ provider: 'opencode-sdk', server, directory, error }, 'OpenCode experimental.mcp.add failed');
    }
  }
}

export const openCodeSdkRuntimeHooks: OpenCodeSdkRuntimeHooks = {
  async start(options) {
    // Dynamic import keeps the controlled-node thin bundle free of `@opencode/sdk` native addons.
    const { OpenCode } = await import('@opencode/sdk');
    if (options.signal.aborted) {
      const abortErr = new Error('OpenCode startup aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    const dbPath = options.databasePath?.trim()
      || process.env.IMCODES_OPENCODE_DB_PATH?.trim()
      || imcodesStatePath('opencode-sdk.db');
    if (dbPath !== ':memory:') {
      await mkdir(dirname(dbPath), { recursive: true });
    }

    const hostKey = dbPath === ':memory:'
      ? `memory:${options.hostGroupKey?.trim() || 'default'}`
      : `file:${resolve(dbPath)}`;
    const content = buildSanitizedSharedHostConfig(options.config);

    // One shared embedded host per persistent SQLite DB prevents multiple concurrent
    // `SessionRestart.Service` owners and strictly serializes `close()` before reopen.
    const entry = await withSharedHostLock(hostKey, async () => {
      if (options.signal.aborted) {
        const abortErr = new Error('OpenCode startup aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const existing = sharedOpenCodeHosts.get(hostKey);
      if (existing) {
        if (existing.closePromise) {
          await existing.closePromise.catch(() => {});
          if (sharedOpenCodeHosts.get(hostKey) === existing) {
            sharedOpenCodeHosts.delete(hostKey);
          }
        } else if (!existing.closed) {
          existing.refCount += 1;
          return existing;
        }
      }
      const mcpCoordinator = new SharedOpenCodeHostMcpCoordinator();
      const instance = await OpenCode.create({
        database: { path: dbPath },
        fs: { filewatcher: false },
        plugins: [mcpCoordinator.plugin as never],
        ...(content ? { config: { content } } : {}),
      });
      const created: SharedOpenCodeHostEntry = {
        key: hostKey,
        instance: instance as unknown as SharedOpenCodeHostEntry['instance'],
        mcpCoordinator,
        eventConsumers: new Map(),
        eventAbort: null,
        eventLoop: null,
        eventStartPromise: null,
        refCount: 1,
        closed: false,
        closePromise: null,
      };
      sharedOpenCodeHosts.set(hostKey, created);
      return created;
    });

    const stopHostEvents = async (): Promise<void> => {
      const pendingStart = entry.eventStartPromise;
      const abort = entry.eventAbort;
      const loop = entry.eventLoop;
      entry.eventStartPromise = null;
      entry.eventAbort = null;
      entry.eventLoop = null;
      abort?.abort();
      if (pendingStart) await pendingStart.catch(() => {});
      if (loop) await loop.catch(() => {});
    };

    const ensureHostEventLoop = async (): Promise<void> => {
      if (entry.eventLoop && entry.eventAbort && !entry.eventAbort.signal.aborted) return;
      if (entry.eventStartPromise) {
        await entry.eventStartPromise;
        return;
      }
      const eventAbort = new AbortController();
      entry.eventAbort = eventAbort;
      const startPromise = (async () => {
        const subscription = await entry.instance.events.subscribe({}, { signal: eventAbort.signal });
        if (eventAbort.signal.aborted || entry.eventConsumers.size === 0) {
          const earlyStream = 'stream' in subscription ? subscription.stream : subscription;
          void earlyStream[Symbol.asyncIterator]().return?.().catch(() => {});
          return;
        }
        const stream = 'stream' in subscription ? subscription.stream : subscription;
        entry.eventLoop = (async () => {
          const iterator = stream[Symbol.asyncIterator]();
          let abortListener: (() => void) | null = null;
          try {
            const abortPromise = new Promise<{ aborted: true }>((resolveAbort) => {
              if (eventAbort.signal.aborted) {
                resolveAbort({ aborted: true });
                return;
              }
              abortListener = () => {
                void iterator.return?.().catch(() => {});
                resolveAbort({ aborted: true });
              };
              eventAbort.signal.addEventListener('abort', abortListener, { once: true });
            });

            while (!eventAbort.signal.aborted) {
              const step = await Promise.race([
                iterator.next().then((result: IteratorResult<Record<string, any>>) => ({ aborted: false as const, result })),
                abortPromise,
              ]);
              if (step.aborted || eventAbort.signal.aborted) return;
              if (step.result.done) {
                throw new Error('OpenCode event stream ended');
              }
              for (const consumer of [...entry.eventConsumers.values()]) {
                try {
                  consumer.listener(step.result.value);
                } catch (listenerError) {
                  logger.warn({ provider: 'opencode-sdk', error: listenerError }, 'OpenCode event consumer listener threw');
                }
              }
            }
          } catch (error) {
            if (eventAbort.signal.aborted) return;
            for (const consumer of [...entry.eventConsumers.values()]) {
              consumer.onError(error);
            }
          } finally {
            if (abortListener) eventAbort.signal.removeEventListener('abort', abortListener);
            if (eventAbort.signal.aborted) {
              void iterator.return?.().catch(() => {});
            }
            if (entry.eventAbort === eventAbort) {
              entry.eventAbort = null;
              entry.eventLoop = null;
            }
            if (!eventAbort.signal.aborted && !entry.closed && !entry.closePromise && entry.eventConsumers.size > 0) {
              void ensureHostEventLoop().catch((recoverError) => {
                logger.debug({ provider: 'opencode-sdk', error: recoverError }, 'OpenCode host event feed reconnect deferred until next activity');
              });
            }
          }
        })();
      })().catch((error) => {
        if (entry.eventAbort === eventAbort) {
          entry.eventAbort = null;
          entry.eventLoop = null;
        }
        throw error;
      }).finally(() => {
        if (entry.eventStartPromise === startPromise) {
          entry.eventStartPromise = null;
        }
      });
      entry.eventStartPromise = startPromise;
      await startPromise;
    };

    const subscribeEvents: NonNullable<OpenCodeSdkRuntimeStartResult['subscribeEvents']> = async (
      consumerId,
      listener,
      onError,
    ) => {
      entry.eventConsumers.set(consumerId, { listener, onError });
      try {
        await ensureHostEventLoop();
      } catch (error) {
        entry.eventConsumers.delete(consumerId);
        if (entry.eventConsumers.size === 0) await stopHostEvents();
        throw error;
      }
      return async () => {
        entry.eventConsumers.delete(consumerId);
        if (entry.eventConsumers.size === 0) {
          await stopHostEvents();
        }
      };
    };

    let releasePromise: Promise<void> | null = null;
    const close = (): Promise<void> => {
      if (releasePromise) return releasePromise;
      releasePromise = withSharedHostLock(hostKey, async () => {
        if (entry.closePromise) {
          await entry.closePromise.catch(() => {});
          return;
        }
        entry.refCount = Math.max(0, entry.refCount - 1);
        if (entry.refCount > 0 || entry.closed) return;
        entry.closed = true;
        const closing = (async () => {
          entry.eventConsumers.clear();
          await stopHostEvents();
          await entry.mcpCoordinator.closeAll().catch(() => {});
          await entry.instance.close().catch(() => {});
        })().finally(() => {
          if (sharedOpenCodeHosts.get(hostKey) === entry) {
            sharedOpenCodeHosts.delete(hostKey);
          }
        });
        entry.closePromise = closing;
        await closing;
      });
      return releasePromise;
    };

    if (options.signal.aborted) {
      await close();
      const abortErr = new Error('OpenCode startup aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    options.signal.addEventListener('abort', () => {
      void close();
    }, { once: true });

    const client = entry.instance as unknown as OpenCodeClientLike;

    if (options.warmupCatalog) {
      // `PluginSupervisor` registers internal provider/model plugins asynchronously
      // after `OpenCode.create()` returns; poll the target location so initial `listModels()`
      // sees the populated catalog immediately after `connect()`.
      const warmupLocation = { directory: safeString(options.directory) ?? process.cwd() };
      const warmupMs = Math.min(options.timeout || 10_000, PLUGIN_WARMUP_MAX_WAIT_MS);
      const deadline = Date.now() + warmupMs;
      while (Date.now() < deadline && !options.signal.aborted) {
        try {
          const [providersRes, modelsRes] = await Promise.all([
            entry.instance.provider.list({ location: warmupLocation }),
            entry.instance.model.list({ location: warmupLocation }),
          ]);
          if ((providersRes?.data?.length ?? 0) > 0 && (modelsRes?.data?.length ?? 0) > 0) break;
        } catch {
          break;
        }
        await sleep(PLUGIN_WARMUP_POLL_MS);
      }
    }

    return {
      client,
      server: { url: `http://${LOOPBACK_HOST}:${options.port}`, close },
      subscribeEvents,
      ensureEvents: ensureHostEventLoop,
      bindSessionMcp: (providerSessionId, directory, mcpServers) => entry.mcpCoordinator.bindSession(providerSessionId, directory, mcpServers),
      unbindSessionMcp: (providerSessionId) => entry.mcpCoordinator.unbindSession(providerSessionId),
    };
  },
};

const defaultOpenCodeSdkStart = openCodeSdkRuntimeHooks.start;

interface NormalizedOpenCodePermission {
  id: string;
  operation?: string;
  title?: string;
  pattern?: string;
  rawInput?: unknown;
  callId?: string;
}

interface PendingOpenCodeForm {
  requestId: string;
  questions: AskQuestionItem[];
  fields: Array<{ key: string; type: string }>;
  callId?: string;
}

interface OpenCodeModelReasoningMeta {
  supportsReasoning: boolean;
  supportedEffortLevels?: readonly TransportEffortLevel[];
  variantKeys: readonly string[];
}

interface OpenCodeCompactRequestState {
  generation: number;
  inputId: string;
  startedInputId: string | null;
  manualStarted: boolean;
  sawV2Compaction: boolean;
}

interface OpenCodeSessionState {
  routeId: string;
  providerSessionId: string;
  cwd: string;
  model?: string;
  activeStepProviderId?: string;
  effort?: TransportEffortLevel;
  appliedModelSignature: string | null;
  syncedMcpSignature: string | null;
  busy: boolean;
  compacting: boolean;
  compactRequest: OpenCodeCompactRequestState | null;
  compactCompletionEmitted: boolean;
  generation: number;
  cancelled: boolean;
  completionEmitted: boolean;
  terminalErrorEmitted: boolean;
  authHealInFlight: boolean;
  authHealPhase: 'none' | 'preparing' | 'retry-dispatched' | 'retry-active';
  authHealRetryAcked: boolean;
  priorAttemptAssistantIds: Set<string>;
  priorAttemptUserMessageIds: Set<string>;
  openCodeCredSwitchedDuringTurn: boolean;
  openCodeCredChangedIdsDuringTurn: Set<string>;
  retryTerminalReconcileInFlight: boolean;
  retryTerminalHint: string | null;
  retryTerminalError: unknown;
  retryActivitySeq: number;
  retryReconcileToken: number;
  pendingAdmissionAbort: AbortController | null;
  activeTurnParams: {
    generation: number;
    text: string;
    files: Array<Record<string, unknown>>;
    system?: string;
    messageId: string;
    startedAt: number;
    credEpochAtDispatch: number;
    expectedCredIdAtDispatch: string | null | undefined;
    expectedCredFingerprintAtDispatch: string | undefined;
    authHealAttempted: boolean;
  } | null;
  missingFinalRecoveryAttempted: boolean;
  missingFinalRecoveryInFlight: boolean;
  cronControlActive: boolean;
  silentToolResult: string | null;
  deliveryMessageId: string | null;
  currentMessageId: string | null;
  textParts: Map<string, string>;
  toolNames: Map<string, string>;
  toolInputs: Map<string, unknown>;
  toolSignatures: Map<string, string>;
  surfacedQuestionCallIds: Set<string>;
  lastUsageSignature: string | null;
  lastUsage: ProviderUsageUpdate['usage'];
  lastUsageMessageId: string | null;
  client: OpenCodeClientLike;
  server: OpenCodeServerLike;
  abort: AbortController;
  ensureEvents: () => Promise<void>;
  releaseEvents: () => Promise<void>;
  bindSessionMcp?: OpenCodeSdkRuntimeStartResult['bindSessionMcp'];
  unbindSessionMcp?: OpenCodeSdkRuntimeStartResult['unbindSessionMcp'];
  pendingPermissions: Map<string, ReturnType<typeof setTimeout>>;
  runtimeConfig: SessionConfig;
  /** The native-agent fence this session's own OpenCode runtime was started with. */
  nativeAgentFence: NativeAgentFence;
}

class OpenCodeRequestTimeoutError extends Error {
  constructor(operation: string, timeoutMs = MISSING_FINAL_RECOVERY_TIMEOUT_MS) {
    super(`OpenCode ${operation} timed out after ${timeoutMs}ms`);
    this.name = 'OpenCodeRequestTimeoutError';
  }
}

function invokeWithOptionalSignal<TInput, TResult>(
  fn: (input: TInput, requestOptions?: { signal?: AbortSignal }) => Promise<TResult>,
  input: TInput,
  signal: AbortSignal,
): Promise<TResult> {
  return fn.length >= 2 ? fn(input, { signal }) : fn(input);
}

function withOpenCodeRequestTimeout<T>(
  promise: Promise<T>,
  operation: string,
  abortController?: AbortController,
  timeoutMs = MISSING_FINAL_RECOVERY_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const abortErr = new Error(`OpenCode ${operation} aborted`);
      abortErr.name = 'AbortError';
      reject(abortErr);
    };
    const cleanup = () => {
      clearTimeout(timer);
      abortController?.signal.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      abortController?.signal.removeEventListener('abort', onAbort);
      abortController?.abort();
      reject(new OpenCodeRequestTimeoutError(operation, timeoutMs));
    }, timeoutMs);
    timer.unref?.();

    if (abortController) {
      if (abortController.signal.aborted) {
        onAbort();
        return;
      }
      abortController.signal.addEventListener('abort', onAbort, { once: true });
    }

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, unknown>).message as string;
  }
  try { return JSON.stringify(error); } catch { return String(error); }
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function errorHttpStatus(error: unknown): number | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let depth = 0; pending.length > 0 && depth < 8; depth++) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.status === 'number' && Number.isFinite(record.status)) return record.status;
    if (record.cause !== undefined) pending.push(record.cause);
  }
  return undefined;
}

function isNotFoundError(error: unknown): boolean {
  if (errorHttpStatus(error) === 404) return true;
  if (error && typeof error === 'object') {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.includes('NotFound')) return true;
  }
  const msg = errorMessage(error);
  return /\b404\b/.test(msg) || /\bnot found\b/i.test(msg);
}

function openCodePromptMessageId(providerSessionId: string, deliveryId: string | undefined): string {
  const stableInput = deliveryId?.trim() || randomUUID();
  const digest = createHash('sha256')
    .update(providerSessionId)
    .update('\0')
    .update(stableInput)
    .digest('hex')
    .slice(0, 26);
  return `msg_${digest}`;
}

function openCodeRecoveryMessageId(providerSessionId: string, deliveryMessageId: string): string {
  return openCodePromptMessageId(providerSessionId, `${deliveryMessageId}\0missing-final-recovery`);
}

function openCodeAuthHealRetryMessageId(providerSessionId: string, deliveryMessageId: string): string {
  return openCodePromptMessageId(providerSessionId, `${deliveryMessageId}\0auth-heal-retry`);
}

function openCodeCompactInputId(providerSessionId: string): string {
  return openCodePromptMessageId(providerSessionId, `compact\0${randomUUID()}`);
}

function errorResponseBodyText(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const record = error as Record<string, unknown>;
  const response = record.response as Record<string, unknown> | undefined;
  if (typeof response?.body === 'string') return response.body;
  if (typeof record.body === 'string') return record.body;
  return '';
}

function errorExplicitProviderId(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const data = record.data as Record<string, unknown> | undefined;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const nestedError = record.error as Record<string, unknown> | undefined;
  return safeString(record.providerID)
    ?? safeString(data?.providerID)
    ?? safeString(metadata?.providerID)
    ?? safeString(nestedError?.providerID)
    ?? safeString((nestedError?.data as Record<string, unknown> | undefined)?.providerID);
}

function errorExplicitCredentialId(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const data = record.data as Record<string, unknown> | undefined;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const nestedError = record.error as Record<string, unknown> | undefined;
  return safeString(record.credentialID)
    ?? safeString(data?.credentialID)
    ?? safeString(metadata?.credentialID)
    ?? safeString(nestedError?.credentialID)
    ?? safeString((nestedError?.data as Record<string, unknown> | undefined)?.credentialID);
}

function fingerprintCredentialValue(cred: Record<string, any> | undefined): string | undefined {
  if (!cred || typeof cred !== 'object') return undefined;
  if (cred.value === undefined) return undefined;
  return createHash('sha256')
    .update(JSON.stringify({ id: cred.id ?? null, label: cred.label ?? null, value: cred.value }))
    .digest('hex');
}

function errorExplicitCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const record = error as Record<string, unknown>;
  const data = record.data as Record<string, unknown> | undefined;
  const nestedError = record.error as Record<string, unknown> | undefined;
  return (
    safeString(record.code)
    ?? safeString(data?.code)
    ?? safeString(nestedError?.code)
    ?? safeString((nestedError?.data as Record<string, unknown> | undefined)?.code)
    ?? ''
  ).toLowerCase();
}

function isExpiredOpenCodeAuthError(error: unknown, sessionProviderId: string | undefined): boolean {
  const explicitProvider = errorExplicitProviderId(error);
  // Attribution must never conflict: reject when either the active turn's SDK provider
  // or the error's explicit provider metadata points away from `opencode`.
  if (sessionProviderId !== undefined && sessionProviderId !== 'opencode') return false;
  if (explicitProvider !== undefined && explicitProvider !== 'opencode') return false;
  if ((explicitProvider ?? sessionProviderId) !== 'opencode') return false;

  const data = error && typeof error === 'object' ? (error as { data?: Record<string, unknown> }).data : undefined;
  const response = error && typeof error === 'object' ? (error as { response?: Record<string, unknown> }).response : undefined;
  const nestedStatus = typeof data?.statusCode === 'number' && Number.isFinite(data.statusCode)
    ? data.statusCode
    : typeof response?.status === 'number' && Number.isFinite(response.status)
      ? response.status
      : undefined;
  const status = errorHttpStatus(error) ?? nestedStatus;
  // Explicit non-401 HTTP status (such as 403/400/429/500) must never trigger credential deletion.
  if (status !== undefined && status !== 401) return false;

  const errorType = error && typeof error === 'object'
    ? safeString((error as { type?: unknown }).type)?.toLowerCase() ?? ''
    : '';
  const errorName = error && typeof error === 'object'
    ? safeString((error as { name?: unknown }).name)?.toLowerCase() ?? ''
    : '';
  const code = errorExplicitCode(error);
  const combined = `${errorMessage(error)}\n${errorResponseBodyText(error)}`.toLowerCase();

  const is401 = status === 401;
  const isStatuslessSdkAuth = status === undefined && (errorType === 'provider.auth' || errorName.includes('providerautherror'));
  const hasExpiredKeyMarker = code === 'api_key_expired'
    || /\bapi_key_expired\b/.test(combined)
    || /\bapi[_ ]?key[^a-z0-9]{1,8}expired\b/.test(combined);
  return (is401 || isStatuslessSdkAuth) && hasExpiredKeyMarker;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isTerminalFinish(finish: unknown): boolean {
  const normalized = safeString(finish)?.toLowerCase();
  // OpenCode finishes each intermediate tool-call step with `tool-calls` (or `unknown`).
  // Only an explicit terminal finish ends the turn; `session.execution.succeeded` and
  // `session.idle` remain the fallback for steps omitting a terminal finish.
  return normalized !== undefined && normalized !== 'tool-calls' && normalized !== 'unknown';
}

function isTerminalAssistantMessage(msg: Record<string, any> | undefined): boolean {
  if (!msg || msg.type !== 'assistant') return false;
  if (msg.error) return true;
  return isTerminalFinish(msg.finish);
}

function sessionIdFromEvent(event: Record<string, any>): string | undefined {
  const data = event.data ?? event.properties;
  return safeString(data?.sessionID)
    ?? safeString(data?.form?.sessionID)
    ?? safeString(data?.part?.sessionID)
    ?? safeString(data?.info?.sessionID);
}

function permissionPattern(value: unknown): string | undefined {
  if (!Array.isArray(value)) return safeString(value);
  const items = value.map(safeString).filter((item): item is string => item !== undefined);
  return items.length > 0 ? items.join(', ') : undefined;
}

function normalizePermissionEvent(
  eventType: unknown,
  payload: Record<string, any> | undefined,
): NormalizedOpenCodePermission | undefined {
  const id = safeString(payload?.id);
  if (!id) return undefined;
  if (eventType === OPENCODE_PERMISSION_EVENT.ASKED) {
    return {
      id,
      operation: safeString(payload?.action) ?? safeString(payload?.permission),
      title: safeString(payload?.message),
      pattern: permissionPattern(payload?.resources ?? payload?.patterns),
      rawInput: payload,
      callId: safeString(payload?.source?.callID ?? payload?.tool?.callID),
    };
  }
  if (eventType === OPENCODE_PERMISSION_EVENT.V2_ASKED) {
    return {
      id,
      operation: safeString(payload?.action),
      title: safeString(payload?.message),
      pattern: permissionPattern(payload?.resources),
      rawInput: payload,
      callId: safeString(payload?.source?.callID),
    };
  }
  if (eventType === OPENCODE_PERMISSION_EVENT.LEGACY_UPDATED) {
    return {
      id,
      operation: safeString(payload?.type),
      title: safeString(payload?.title),
      pattern: permissionPattern(payload?.pattern),
      rawInput: payload,
      callId: safeString(payload?.callID),
    };
  }
  return undefined;
}

function normalizeFormToQuestions(form: Record<string, any> | undefined): {
  requestId: string;
  questions: AskQuestionItem[];
  fields: Array<{ key: string; type: string }>;
} | undefined {
  const requestId = safeString(form?.id);
  if (!requestId || !Array.isArray(form?.fields) || form.fields.length === 0) return undefined;
  const header = safeString(form.title) ?? 'Question';
  const questions: AskQuestionItem[] = [];
  const fields: Array<{ key: string; type: string }> = [];
  for (const field of form.fields) {
    if (!field || typeof field !== 'object') continue;
    const key = safeString(field.key);
    const type = safeString(field.type) ?? 'string';
    if (!key) continue;
    const questionText = safeString(field.title) ?? safeString(field.description) ?? key;
    const rawOptions: unknown[] | undefined = Array.isArray(field.options) ? field.options : undefined;
    const mappedOptions = rawOptions
      ?.map((opt: any): { label: string; description?: string } | undefined => {
        const label = safeString(opt?.label ?? opt?.value ?? opt);
        if (!label) return undefined;
        const description = safeString(opt?.description);
        return description ? { label, description } : { label };
      })
      .filter((item): item is { label: string; description?: string } => item !== undefined);
    const options = mappedOptions && mappedOptions.length > 0 ? mappedOptions : undefined;
    questions.push({
      header,
      question: questionText,
      ...(options ? { options } : {}),
      ...(type === 'multiselect' ? { multiSelect: true } : {}),
    });
    fields.push({ key, type });
  }
  if (questions.length === 0) return undefined;
  return { requestId, questions, fields };
}

function formatFormAnswerRecord(
  fields: Array<{ key: string; type: string }>,
  parsedAnswers: string[][],
  rawFallback: string,
): Record<string, string | number | boolean | string[]> {
  const record: Record<string, string | number | boolean | string[]> = {};
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const selected = parsedAnswers[i] ?? [];
    if (field.type === 'multiselect') {
      record[field.key] = selected;
    } else if (field.type === 'boolean') {
      const token = (selected[0] ?? rawFallback).trim().toLowerCase();
      record[field.key] = token === 'true' || token === 'yes' || token === '1' || token === 'y';
    } else if (field.type === 'number' || field.type === 'integer') {
      const raw = selected[0] ?? rawFallback;
      const num = Number(raw);
      record[field.key] = Number.isFinite(num) ? num : raw;
    } else {
      record[field.key] = selected[0] ?? rawFallback;
    }
  }
  return record;
}

function parseModelIdentity(value: string | undefined): { providerID: string; modelID: string } | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

function extractModelReasoningMeta(model: Record<string, any> | undefined): OpenCodeModelReasoningMeta {
  const disabledVariants = new Set<string>();
  const variantKeys: string[] = [];
  if (Array.isArray(model?.variants)) {
    for (const variant of model.variants) {
      const id = safeString(typeof variant === 'string' ? variant : variant?.id);
      if (!id) continue;
      if (variant && typeof variant === 'object' && variant.disabled === true) {
        disabledVariants.add(id);
        continue;
      }
      variantKeys.push(id);
    }
  } else if (model?.variants && typeof model.variants === 'object') {
    for (const [key, value] of Object.entries(model.variants as Record<string, any>)) {
      const normalizedKey = safeString(key);
      if (!normalizedKey) continue;
      if (value && typeof value === 'object' && (value as Record<string, unknown>).disabled === true) {
        disabledVariants.add(normalizedKey);
        continue;
      }
      variantKeys.push(normalizedKey);
    }
  }

  const effortValues: string[] = [];
  if (Array.isArray(model?.reasoning_options)) {
    for (const option of model.reasoning_options) {
      if (option?.type !== 'effort' || !Array.isArray(option.values)) continue;
      for (const value of option.values) {
        const normalizedValue = safeString(value);
        if (!normalizedValue || disabledVariants.has(normalizedValue)) continue;
        effortValues.push(normalizedValue);
      }
    }
  }

  const combinedKeys = [...new Set([...effortValues, ...variantKeys])];
  const supportedEffortLevels = normalizeSupportedEffortLevels(combinedKeys);
  const supportsReasoning = Boolean(
    model?.capabilities?.reasoning
    || model?.reasoning
    || combinedKeys.length > 0
    || (supportedEffortLevels && supportedEffortLevels.length > 0),
  );

  return {
    supportsReasoning,
    ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
    variantKeys: combinedKeys,
  };
}

function extractToolContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
    } else if (typeof record.text === 'string') {
      parts.push(record.text);
    } else {
      try { parts.push(JSON.stringify(record)); } catch { /* ignore */ }
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function providerError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
  return { code, message, recoverable, ...(details === undefined ? {} : { details }) };
}

function promptFiles(attachments: TransportAttachment[] | undefined): Array<{
  uri: string;
  source: { type: 'uri'; uri: string };
  name?: string;
}> {
  return (attachments ?? []).map((attachment) => {
    const uri = pathToFileURL(attachment.daemonPath).href;
    return {
      uri,
      source: { type: 'uri' as const, uri },
      ...(attachment.originalName ? { name: attachment.originalName } : {}),
    };
  });
}

function textPartKey(messageId: unknown, ordinal: unknown): string {
  const msg = safeString(messageId) ?? 'assistant';
  const ord = typeof ordinal === 'number' && Number.isFinite(ordinal) ? ordinal : 0;
  return `${msg}:${ord}`;
}

function buildOpenCodeSubagentDenyRules(): OpenCodeSessionPermissionRuleLike[] {
  return OPENCODE_NATIVE_AGENT_TOOLS.map((action) => ({
    action,
    resource: '*',
    effect: 'deny',
  }));
}

function buildOpenCodeGuardedSessionPermissions(
  nativeAgentsFenced: boolean,
  guardTools: boolean,
): OpenCodeSessionPermissionRuleLike[] {
  const rules: OpenCodeSessionPermissionRuleLike[] = [];
  if (guardTools) {
    rules.push({ action: '*', resource: '*', effect: 'ask' });
  }
  if (nativeAgentsFenced) {
    rules.push(...buildOpenCodeSubagentDenyRules());
  }
  return rules;
}

function mergeOpenCodeFencedPermissions(
  existing: readonly OpenCodeSessionPermissionRuleLike[] | undefined,
  nativeAgentsFenced = true,
  guardTools = false,
): OpenCodeSessionPermissionRuleLike[] {
  const denySet = new Set<string>(OPENCODE_NATIVE_AGENT_TOOLS);
  const rules: OpenCodeSessionPermissionRuleLike[] = [];
  if (guardTools) {
    rules.push({ action: '*', resource: '*', effect: 'ask' });
  }
  for (const rule of existing ?? []) {
    if (nativeAgentsFenced && denySet.has(rule.action) && rule.resource === '*') continue;
    // Replay all existing rules in original relative order so global (`*/* deny`),
    // wildcard-action directory (`* /secret/* deny`), and tool-specific denies keep
    // exact `.findLast()` precedence while any executable `allow` becomes `ask`.
    const mapped: OpenCodeSessionPermissionRuleLike = guardTools && rule.effect === 'allow'
      ? { ...rule, effect: 'ask' }
      : rule;
    const prev = rules[rules.length - 1];
    if (prev && prev.action === mapped.action && prev.resource === mapped.resource && prev.effect === mapped.effect) {
      continue;
    }
    rules.push(mapped);
  }
  if (nativeAgentsFenced) {
    rules.push(...buildOpenCodeSubagentDenyRules());
  }
  return rules;
}

function parseJsonRecord(raw: unknown): Record<string, any> | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

function resolveOpenCodeEmbeddedDbCandidates(databasePath: string | undefined): string[] {
  const candidates: string[] = [];
  const defaultEmbeddedDb = resolve(imcodesStatePath('opencode-sdk.db'));
  candidates.push(defaultEmbeddedDb);
  const configuredDb = safeString(databasePath) ?? safeString(process.env.IMCODES_OPENCODE_DB_PATH);
  if (configuredDb && configuredDb !== ':memory:') {
    const resolvedConfigured = resolve(configuredDb);
    if (!candidates.includes(resolvedConfigured)) candidates.push(resolvedConfigured);
  }
  return candidates.filter((candidate) => existsSync(candidate));
}

function resolveOpenCodeV1DbCandidates(): string[] {
  const xdgDataHome = safeString(process.env.XDG_DATA_HOME) ?? join(homedir(), '.local', 'share');
  const defaultLegacyDb = resolve(xdgDataHome, 'opencode', 'opencode.db');
  return existsSync(defaultLegacyDb) ? [defaultLegacyDb] : [];
}

function resolveOpenCodeLegacyDbCandidates(databasePath: string | undefined): string[] {
  const candidates: string[] = [...resolveOpenCodeV1DbCandidates()];
  for (const embeddedCandidate of resolveOpenCodeEmbeddedDbCandidates(databasePath)) {
    if (!candidates.includes(embeddedCandidate)) candidates.push(embeddedCandidate);
  }
  return candidates.filter((candidate) => existsSync(candidate));
}

function normalizeLegacyFinish(finish: unknown): string | undefined {
  if (typeof finish !== 'string') return undefined;
  return ['stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown'].includes(finish) ? finish : 'unknown';
}

function mapLegacyError(rawError: Record<string, any>): { type: string; message: string } {
  const data = rawError.data && typeof rawError.data === 'object' ? (rawError.data as Record<string, any>) : {};
  const name = typeof rawError.name === 'string' ? rawError.name : 'unknown';
  const message = typeof data.message === 'string'
    ? data.message
    : name === 'MessageOutputLengthError'
      ? 'The model exceeded its output limit'
      : name;
  const type = name === 'ProviderAuthError'
    ? 'provider.auth'
    : name === 'ContentFilterError'
      ? 'provider.content-filter'
      : name === 'ContextOverflowError'
        ? 'provider.invalid-request'
        : name === 'StructuredOutputError' || name === 'MessageOutputLengthError'
          ? 'provider.invalid-output'
          : name === 'MessageAbortedError'
            ? 'aborted'
            : name === 'APIError'
              ? 'provider.error'
              : 'unknown';
  return { type, message };
}

function mapLegacyToolPart(part: Record<string, any>, fallbackTime: number): Record<string, unknown> {
  const base = {
    type: 'tool',
    id: safeString(part.callID) ?? randomUUID(),
    name: safeString(part.tool) ?? 'tool',
    ...(part.metadata ? { native: part.metadata } : {}),
  };
  const state = (part.state ?? {}) as Record<string, any>;
  if (state.status === 'completed') {
    const start = Number(state.time?.start ?? fallbackTime);
    const end = Number(state.time?.end ?? start);
    const attachments = Array.isArray(state.attachments)
      ? state.attachments.map((file: Record<string, any>) => ({
        type: 'file',
        uri: file.url,
        mime: file.mime,
        ...(file.filename ? { name: file.filename } : {}),
      }))
      : [];
    return {
      ...base,
      state: {
        status: 'completed',
        input: state.input ?? {},
        content: state.time?.compacted === undefined
          ? [{ type: 'text', text: String(state.output ?? '') }, ...attachments]
          : [{ type: 'text', text: '[Old tool result content cleared]' }],
        ...(state.metadata ? { metadata: state.metadata } : {}),
      },
      time: { created: start, completed: end },
    };
  }
  if (state.status === 'error') {
    const start = Number(state.time?.start ?? fallbackTime);
    const end = Number(state.time?.end ?? start);
    return {
      ...base,
      state: {
        status: 'error',
        input: state.input ?? {},
        error: { type: 'tool.execution', message: String(state.error ?? 'Tool execution error') },
        ...(typeof state.metadata?.output === 'string' ? { content: [{ type: 'text', text: state.metadata.output }] } : {}),
        ...(state.metadata ? { metadata: state.metadata } : {}),
      },
      time: { created: start, completed: end },
    };
  }
  return {
    ...base,
    state: {
      status: 'error',
      input: state.input ?? {},
      error: { type: 'tool.interrupted', message: 'Tool execution was interrupted before V2 migration' },
      ...(state.status === 'running' && state.metadata ? { metadata: state.metadata } : {}),
    },
    time: { created: Number(state.time?.start ?? fallbackTime) },
  };
}

const LEGACY_IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const LEGACY_V1_USER_PART_TYPES = new Set(['text', 'file', 'agent', 'compaction', 'subtask']);
const LEGACY_V1_ASSISTANT_PART_TYPES = new Set([
  'text',
  'reasoning',
  'tool',
  'step-start',
  'step-finish',
  'snapshot',
  'patch',
  'retry',
]);

function mapLegacyFilePart(
  part: Record<string, any>,
  sessionDirectory: string | undefined,
  sessionId: string,
): {
  attachment: Record<string, unknown>;
} {
  const mime = safeString(part.mime) ?? 'application/octet-stream';
  const url = typeof part.url === 'string' ? part.url : '';
  const source = part.source && typeof part.source === 'object' ? (part.source as Record<string, any>) : undefined;
  const filename = safeString(part.filename);
  const sourceText = source?.text && typeof source.text === 'object' ? (source.text as Record<string, any>) : undefined;
  const mention = sourceText && typeof sourceText.value === 'string'
    ? {
      mention: {
        text: sourceText.value,
        start: Number(sourceText.start ?? 0),
        end: Number(sourceText.end ?? 0),
      },
    }
    : {};

  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) {
      throw new Error(`Legacy v1 file part has malformed data URI (${filename ?? mime})`);
    }
    const header = url.slice(0, comma);
    const payload = url.slice(comma + 1);
    const data = header.endsWith(';base64')
      ? Buffer.from(payload, 'base64').toString('base64')
      : Buffer.from(decodeURIComponent(payload)).toString('base64');
    return {
      attachment: {
        data,
        mime,
        source: source?.type === 'resource' && safeString(source.uri)
          ? { type: 'uri', uri: safeString(source.uri) }
          : { type: 'inline' },
        ...(filename ? { name: filename } : {}),
        ...mention,
      },
    };
  }

  const label = filename
    ?? (source?.type === 'resource' ? safeString(source.uri) : undefined)
    ?? (safeString(url) ?? 'attachment');

  if (url.startsWith('file://')) {
    if (!sessionDirectory) {
      throw new Error(
        `Cannot losslessly migrate legacy OpenCode v1 file attachment "${label}" (${mime}) without a session directory. Export via \`opencode export ${sessionId}\`.`,
      );
    }
    let rawPath: string;
    try {
      rawPath = fileURLToPath(url);
    } catch (error) {
      throw new Error(
        `Cannot losslessly migrate legacy OpenCode v1 file attachment "${label}" (${mime}): invalid file URI (${errorMessage(error)}). Export via \`opencode export ${sessionId}\`.`,
      );
    }
    if (!existsSync(rawPath)) {
      throw new Error(
        `Cannot losslessly migrate legacy OpenCode v1 file attachment "${label}" (${mime}): source file "${rawPath}" is missing. Export via \`opencode export ${sessionId}\`.`,
      );
    }
    const realRoot = realpathSync(resolve(sessionDirectory));
    const realTarget = realpathSync(rawPath);
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
      throw new Error(
        `Cannot losslessly migrate legacy OpenCode v1 file attachment "${label}" (${mime}): path "${realTarget}" is outside session directory "${realRoot}". Export via \`opencode export ${sessionId}\`.`,
      );
    }
    const stat = statSync(realTarget);
    if (!stat.isFile()) {
      throw new Error(
        `Cannot losslessly migrate legacy OpenCode v1 file attachment "${label}" (${mime}): path "${realTarget}" is not a regular file. Export via \`opencode export ${sessionId}\`.`,
      );
    }
    if (stat.size > LEGACY_IMPORT_MAX_FILE_BYTES) {
      throw new Error(
        `Cannot losslessly migrate legacy OpenCode v1 file attachment "${label}" (${mime}): file size ${stat.size} exceeds ${LEGACY_IMPORT_MAX_FILE_BYTES} bytes. Export via \`opencode export ${sessionId}\`.`,
      );
    }
    const data = readFileSync(realTarget).toString('base64');
    return {
      attachment: {
        data,
        mime,
        source: source?.type === 'resource' && safeString(source.uri)
          ? { type: 'uri', uri: safeString(source.uri) }
          : { type: 'uri', uri: url },
        ...(filename ? { name: filename } : {}),
        ...mention,
      },
    };
  }

  throw new Error(
    `Cannot losslessly migrate legacy OpenCode v1 file attachment "${label}" (${mime}; unsupported URI scheme). Export via \`opencode export ${sessionId}\`.`,
  );
}

function makeLegacySyntheticId(sourceId: string, usedIds: Set<string>): string {
  const prefix = sourceId.slice(0, 16);
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  for (let salt = 0; ; salt++) {
    const hex = createHash('sha256')
      .update(`v1-synthetic:${sourceId}${salt ? `:${salt}` : ''}`)
      .digest('hex');
    let value = BigInt(`0x${hex}`);
    let suffix = '';
    while (suffix.length < 14) {
      suffix = alphabet[Number(value % 62n)] + suffix;
      value /= 62n;
    }
    const id = `${prefix}${suffix}`;
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
}

function buildLegacyImportMessagesFromV1Rows(
  rawMessages: Array<Record<string, any>>,
  rawParts: Array<Record<string, any>>,
  sessionDirectory: string | undefined,
  sessionId: string,
): {
  messages: Array<Record<string, unknown>>;
  latestUserAgent?: string;
  latestUserModel?: { id: string; providerID: string; variant?: string };
} {
  const messages = rawMessages
    .map((row) => ({ row, data: parseJsonRecord(row.data) }))
    .filter((entry): entry is { row: Record<string, any>; data: Record<string, any> } => Boolean(entry.data))
    .sort((a, b) => Number(a.row.time_created) - Number(b.row.time_created) || String(a.row.id).localeCompare(String(b.row.id)));

  const partsByMessage = new Map<string, Array<Record<string, any>>>();
  for (const partRow of rawParts.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const data = parseJsonRecord(partRow.data);
    if (!data) continue;
    const msgId = String(partRow.message_id ?? '');
    const list = partsByMessage.get(msgId) ?? [];
    list.push(data);
    partsByMessage.set(msgId, list);
  }

  const usedIds = new Set<string>(messages.map(({ row }) => String(row.id)));
  const pairedAssistantIds = new Set<string>();
  const imported: Array<Record<string, unknown>> = [];
  let latestUserAgent: string | undefined;
  let latestUserModel: { id: string; providerID: string; variant?: string } | undefined;

  for (const { row, data } of messages) {
    if (pairedAssistantIds.has(String(row.id))) continue;
    const owned = partsByMessage.get(String(row.id)) ?? [];
    if (data.role === 'user') {
      for (const part of owned) {
        const partType = typeof part.type === 'string' ? part.type : '';
        if (!LEGACY_V1_USER_PART_TYPES.has(partType)) {
          throw new Error(`Unsupported legacy OpenCode v1 user part type "${partType || 'unknown'}" in message ${String(row.id)}`);
        }
      }
      const compaction = owned.find((p) => p.type === 'compaction');
      if (compaction) {
        const pairedSummary = messages.find(
          (c) => c.data.role === 'assistant' && c.data.parentID === row.id && c.data.summary === true,
        );
        if (!pairedSummary || pairedSummary.data.error || pairedSummary.data.time?.completed === undefined) continue;
        pairedAssistantIds.add(String(pairedSummary.row.id));
        const summaryText = (partsByMessage.get(String(pairedSummary.row.id)) ?? [])
          .filter((p) => p.type === 'text' && typeof p.text === 'string' && p.text.length > 0)
          .map((p) => String(p.text))
          .join('\n\n');
        imported.push({
          id: String(row.id),
          type: 'compaction',
          status: 'completed',
          reason: compaction.auto ? 'auto' : 'manual',
          summary: summaryText,
          time: { created: Number(row.time_created) },
        });
        continue;
      }

      if (typeof data.agent === 'string' && data.agent.trim()) latestUserAgent = data.agent.trim();
      if (data.model && typeof data.model === 'object') {
        const providerID = safeString(data.model.providerID);
        const id = safeString(data.model.modelID ?? data.model.id);
        if (providerID && id) {
          latestUserModel = {
            id,
            providerID,
            ...(safeString(data.model.variant) ? { variant: safeString(data.model.variant) } : {}),
          };
        }
      }

      const subtasks = owned.filter((p) => p.type === 'subtask');
      const visible = owned.filter((p) => p.type === 'text' && !p.ignored && typeof p.text === 'string');
      const files = owned.filter((p) => p.type === 'file');
      const agents = owned.filter((p) => p.type === 'agent');
      if (subtasks.length > 0 && visible.length === 0 && files.length === 0 && agents.length === 0) {
        continue;
      }

      const ordinary = visible.filter((p) => !p.synthetic);
      const synthetic = visible.filter((p) => p.synthetic);
      const convertedAttachments: Array<Record<string, unknown>> = [];
      const unavailableNotices: string[] = [];
      const textChunks: string[] = [];

      for (const part of owned) {
        if (part.type === 'text' && !part.ignored && !part.synthetic && typeof part.text === 'string') {
          textChunks.push(part.text);
        } else if (part.type === 'file') {
          const mapped = mapLegacyFilePart(part, sessionDirectory, sessionId);
          convertedAttachments.push(mapped.attachment);
        }
      }
      const visibleText = textChunks.join('\n\n');
      const agentAttachments = agents
        .filter((p) => safeString(p.name))
        .map((p) => ({
          name: safeString(p.name)!,
          ...(p.source && typeof p.source === 'object' && typeof p.source.value === 'string'
            ? {
              mention: {
                text: String(p.source.value),
                start: Number(p.source.start ?? 0),
                end: Number(p.source.end ?? 0),
              },
            }
            : {}),
        }));
      const syntheticText = synthetic.map((p) => String(p.text)).join('\n\n');

      if (
        ordinary.length === 0
        && unavailableNotices.length === 0
        && synthetic.length > 0
        && convertedAttachments.length === 0
        && agentAttachments.length === 0
      ) {
        imported.push({
          id: String(row.id),
          type: 'synthetic',
          text: syntheticText,
          time: { created: Number(row.time_created) },
        });
        continue;
      }

      if (
        visibleText
        || convertedAttachments.length > 0
        || agentAttachments.length > 0
        || ordinary.length > 0
      ) {
        imported.push({
          id: String(row.id),
          type: 'user',
          text: visibleText,
          ...(convertedAttachments.length > 0 ? { files: convertedAttachments } : {}),
          ...(agentAttachments.length > 0 ? { agents: agentAttachments } : {}),
          time: { created: Number(row.time_created) },
        });
      }
      if (syntheticText) {
        imported.push({
          id: makeLegacySyntheticId(String(row.id), usedIds),
          type: 'synthetic',
          text: syntheticText,
          time: { created: Number(row.time_created) },
        });
      }
      continue;
    }

    if (data.role !== 'assistant') {
      throw new Error(`Unsupported legacy OpenCode v1 message role "${String(data.role ?? 'unknown')}" in message ${String(row.id)}`);
    }
    for (const part of owned) {
      const partType = typeof part.type === 'string' ? part.type : '';
      if (!LEGACY_V1_ASSISTANT_PART_TYPES.has(partType)) {
        throw new Error(`Unsupported legacy OpenCode v1 assistant part type "${partType || 'unknown'}" in message ${String(row.id)}`);
      }
    }
    const content = owned.flatMap((part) => {
      if (part.type === 'text' && typeof part.text === 'string') {
        return [{ type: 'text', text: part.text, ...(part.metadata ? { native: part.metadata } : {}) }];
      }
      if (part.type === 'reasoning' && typeof part.text === 'string') {
        return [{
          type: 'reasoning',
          text: part.text,
          ...(part.metadata ? { native: part.metadata } : {}),
          time: {
            created: Number(part.time?.start ?? row.time_created),
            ...(part.time?.end !== undefined ? { completed: Number(part.time.end) } : {}),
          },
        }];
      }
      if (part.type === 'tool') return [mapLegacyToolPart(part, Number(row.time_created))];
      return [];
    });
    const startSnapshot = owned.find((p) => p.type === 'step-start' && safeString(p.snapshot))?.snapshot
      ?? owned.find((p) => p.type === 'snapshot' && safeString(p.snapshot))?.snapshot
      ?? owned.find((p) => p.type === 'patch' && safeString(p.hash))?.hash;
    const endSnapshot = [...owned].reverse().find((p) => p.type === 'step-finish' && safeString(p.snapshot))?.snapshot;
    const snapshotFiles = Array.from(new Set(
      owned.flatMap((p) => (p.type === 'patch' && Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === 'string') : [])),
    ));

    const providerID = safeString(data.providerID ?? data.model?.providerID) ?? latestUserModel?.providerID ?? 'opencode';
    const modelID = safeString(data.modelID ?? data.model?.modelID ?? data.model?.id) ?? latestUserModel?.id ?? 'big-pickle';
    const finish = normalizeLegacyFinish(data.finish);
    imported.push({
      id: String(row.id),
      type: 'assistant',
      agent: safeString(data.agent) ?? latestUserAgent ?? 'build',
      model: {
        providerID,
        id: modelID,
        variant: safeString(data.variant) ?? 'default',
      },
      content,
      ...(startSnapshot || endSnapshot || snapshotFiles.length > 0
        ? {
          snapshot: {
            ...(startSnapshot ? { start: startSnapshot } : {}),
            ...(endSnapshot ? { end: endSnapshot } : {}),
            ...(snapshotFiles.length > 0 ? { files: snapshotFiles } : {}),
          },
        }
        : {}),
      ...(finish ? { finish } : {}),
      cost: Number(data.cost ?? 0),
      tokens: {
        input: Number(data.tokens?.input ?? 0),
        output: Number(data.tokens?.output ?? 0),
        reasoning: Number(data.tokens?.reasoning ?? 0),
        cache: {
          read: Number(data.tokens?.cache?.read ?? 0),
          write: Number(data.tokens?.cache?.write ?? 0),
        },
      },
      ...(data.error && typeof data.error === 'object' ? { error: mapLegacyError(data.error as Record<string, any>) } : {}),
      time: {
        created: Number(row.time_created),
        ...(data.time?.completed !== undefined ? { completed: Number(row.time_updated ?? row.time_created) } : {}),
      },
    });
  }

  return { messages: imported, latestUserAgent, latestUserModel };
}

async function readLegacySessionImportPayload(
  sessionId: string,
  databasePath: string | undefined,
  directoryHint: string | undefined,
  preferredOwner?: SessionConfig['openCodeStorageOwner'],
): Promise<{ payload: Record<string, unknown>; sourceDbPath: string } | null> {
  let orderedCandidates: string[];
  if (preferredOwner === 'embedded') {
    orderedCandidates = resolveOpenCodeEmbeddedDbCandidates(databasePath);
  } else if (preferredOwner === 'v1-cli') {
    orderedCandidates = resolveOpenCodeV1DbCandidates();
  } else {
    const rawCandidates = resolveOpenCodeLegacyDbCandidates(databasePath);
    if (rawCandidates.length > 1) {
      const snapshots = await inspectOpenCodeSqliteSessions(sessionId, rawCandidates);
      if (snapshots.length > 1) {
        snapshots.sort((a, b) => compareOpenCodeSessionSnapshots(b, a));
        const ranked = snapshots.map((s) => s.dbPath);
        orderedCandidates = [...ranked, ...rawCandidates.filter((c) => !ranked.includes(c))];
      } else {
        orderedCandidates = rawCandidates;
      }
    } else {
      orderedCandidates = rawCandidates;
    }
  }
  if (orderedCandidates.length === 0) return null;
  const candidates = orderedCandidates;

  let DatabaseSyncCtor: typeof import('node:sqlite')['DatabaseSync'];
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
  } catch (error) {
    throw new Error(
      `OpenCode legacy session "${sessionId}" cannot be imported because Node SQLite support is unavailable (${errorMessage(error)}). Export the legacy session with \`opencode export ${sessionId}\` before restoring in OpenCode v2.`,
    );
  }

  for (const dbFile of candidates) {
    let db: import('node:sqlite').DatabaseSync | null = null;
    try {
      db = new DatabaseSyncCtor(dbFile, { readOnly: true });
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name),
      );
      let sessionRow: Record<string, any> | undefined;
      if (tables.has('session_v2')) {
        sessionRow = db.prepare('SELECT * FROM session_v2 WHERE id = ? LIMIT 1').get(sessionId) as Record<string, any> | undefined;
      }
      if (!sessionRow && tables.has('session')) {
        sessionRow = db.prepare('SELECT * FROM session WHERE id = ? LIMIT 1').get(sessionId) as Record<string, any> | undefined;
      }
      if (!sessionRow) continue;

      let messages: Array<Record<string, unknown>> = [];
      let inferredAgent = safeString(sessionRow.agent);
      const rawModel = typeof sessionRow.model === 'string' ? parseJsonRecord(sessionRow.model) : (sessionRow.model as Record<string, any> | undefined);
      let inferredModel = rawModel && safeString(rawModel.providerID) && safeString(rawModel.id ?? rawModel.modelID)
        ? {
          id: safeString(rawModel.id ?? rawModel.modelID)!,
          providerID: safeString(rawModel.providerID)!,
          ...(safeString(rawModel.variant) ? { variant: safeString(rawModel.variant) } : {}),
        }
        : undefined;

      if (tables.has('session_message')) {
        const smRows = db.prepare(
          'SELECT id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq ASC',
        ).all(sessionId) as Array<Record<string, any>>;
        if (smRows.length > 0) {
          messages = smRows.map((sm) => {
            const parsed = parseJsonRecord(sm.data) ?? {};
            return {
              ...parsed,
              id: String(sm.id),
              type: String(sm.type),
              ...(parsed.time ? {} : { time: { created: Number(sm.time_created ?? Date.now()) } }),
            };
          });
        }
      }

      const sessionScopeDirectory = safeString(sessionRow.directory) ?? directoryHint;
      const resolvedDirectory = sessionScopeDirectory ?? process.cwd();

      if (messages.length === 0 && tables.has('message')) {
        const rawMessages = db.prepare(
          'SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC',
        ).all(sessionId) as Array<Record<string, any>>;
        const rawParts = tables.has('part')
          ? (db.prepare('SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY id ASC').all(sessionId) as Array<Record<string, any>>)
          : [];
        const converted = buildLegacyImportMessagesFromV1Rows(rawMessages, rawParts, sessionScopeDirectory, sessionId);
        messages = converted.messages;
        inferredAgent ??= converted.latestUserAgent;
        inferredModel ??= converted.latestUserModel;
      }
      const createdAt = Number(sessionRow.time_created ?? Date.now());
      const updatedAt = Number(sessionRow.time_updated ?? createdAt);
      const archivedAt = typeof sessionRow.time_archived === 'number' ? sessionRow.time_archived : undefined;
      const metadata = typeof sessionRow.metadata === 'string' ? parseJsonRecord(sessionRow.metadata) : undefined;
      const permissions = typeof sessionRow.permission === 'string'
        ? (() => {
          try {
            const p = JSON.parse(sessionRow.permission);
            if (!Array.isArray(p)) return undefined;
            const normalized = p.flatMap((entry) => {
              if (!entry || typeof entry !== 'object') return [];
              const rec = entry as Record<string, unknown>;
              const hasV2Resource = typeof rec.resource === 'string' && rec.resource.trim().length > 0;
              const action = hasV2Resource
                ? safeString(rec.action)
                : safeString(rec.permission ?? rec.action);
              const resource = safeString(rec.resource ?? rec.pattern) ?? '*';
              const rawEffect = safeString(rec.effect) ?? (!hasV2Resource ? safeString(rec.action) : undefined);
              const effect = rawEffect === 'allow' || rawEffect === 'deny' || rawEffect === 'ask' ? rawEffect : undefined;
              if (!action || !effect) return [];
              return [{ action, resource, effect }];
            });
            return normalized.length > 0 ? normalized : undefined;
          } catch {
            return undefined;
          }
        })()
        : undefined;

      return {
        sourceDbPath: dbFile,
        payload: {
          location: { directory: resolvedDirectory },
          info: {
            id: String(sessionRow.id),
            ...(safeString(sessionRow.parent_id) ? { parentID: safeString(sessionRow.parent_id) } : {}),
            projectID: safeString(sessionRow.project_id) ?? 'global',
            ...(inferredAgent ? { agent: inferredAgent } : {}),
            ...(inferredModel ? { model: inferredModel } : {}),
            cost: Number(sessionRow.cost ?? 0),
            tokens: {
              input: Number(sessionRow.tokens_input ?? 0),
              output: Number(sessionRow.tokens_output ?? 0),
              reasoning: Number(sessionRow.tokens_reasoning ?? 0),
              cache: {
                read: Number(sessionRow.tokens_cache_read ?? 0),
                write: Number(sessionRow.tokens_cache_write ?? 0),
              },
            },
            time: {
              created: createdAt,
              updated: updatedAt,
              ...(archivedAt !== undefined ? { archived: archivedAt } : {}),
            },
            ...(safeString(sessionRow.title) ? { title: safeString(sessionRow.title) } : {}),
            ...(metadata ? { metadata } : {}),
            ...(permissions ? { permissions } : {}),
            location: { directory: resolvedDirectory },
          },
          messages,
        },
      };
    } catch (error) {
      throw new Error(
        `Failed to read legacy OpenCode v1 session "${sessionId}" from ${dbFile}: ${errorMessage(error)}. Export via \`opencode export ${sessionId}\`, verify file permissions, or upgrade via \`opencode upgrade --major\`.`,
      );
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return null;
}

export class OpenCodeSdkProvider implements TransportProvider, InteractiveQuestionAnswerer {
  readonly id = 'opencode-sdk';
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: true,
    sessionRestore: true,
    multiTurn: true,
    attachments: true,
    reasoningEffort: true,
    supportedEffortLevels: OPENCODE_SDK_EFFORT_LEVELS,
    contextSupport: 'full-normalized-context-injection',
    compact: {
      execution: 'sdk-rpc',
      verified: true,
      completion: 'rpc-result-or-provider-event',
      cancellation: 'provider-cancel',
      reassertsSessionSystemText: true,
    },
    activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
    restartDurableDeliveryId: {
      restartDurable: true,
      replayAfterAcceptance: 'deduplicated',
    },
    nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.SESSION_FENCE,
  };

  private readonly providerConsumerId = Symbol('opencode-provider');
  private readonly activeClientEventSubs = new Map<OpenCodeClientLike, {
    refCount: number;
    readyPromise: Promise<void> | null;
    broken: boolean;
    closed: boolean;
    currentSubAbort: AbortController | null;
    ensureLive: () => Promise<void>;
    unsubscribe: () => Promise<void>;
  }>();
  private readonly providerSessionLocks = new Map<string, Promise<void>>();
  private openCodeCredentialEpoch = 0;
  private knownActiveOpenCodeCredId: string | null | undefined;
  private knownActiveOpenCodeCredFingerprint: string | undefined;
  private openCodeCredentialProvenanceLoaded = false;
  private openCodeCredentialProvenanceDirty = false;
  private readonly seenEventIds = new Set<string>();
  private readonly hostGroupKey = randomUUID();
  private client: OpenCodeClientLike | null = null;
  private server: OpenCodeServerLike | null = null;
  private lifecycleAbort: AbortController | null = null;
  private connectInFlight: Promise<void> | null = null;
  private databasePath: string | undefined;
  private catalogDirectory = process.cwd();
  private transportResolution: OpenCodeTransportResolution | null = null;
  private v1Delegate: OpenCodeV1CliProvider | null = null;
  private embeddedFallbackDelegate: OpenCodeSdkProvider | null = null;
  private embeddedFallbackConnectPromise: Promise<OpenCodeSdkProvider> | null = null;
  private readonly embeddedFallbackRoutes = new Set<string>();
  private delegateDisposers: Array<() => void> = [];
  private nativeAgentFenceResolver?: NativeAgentFenceResolver;
  private connectConfig: ProviderConfig = {};
  private sessions = new Map<string, OpenCodeSessionState>();
  private readonly legacyImportInFlight = new Map<string, Promise<OpenCodeSessionInfoLike | null>>();
  private readonly pendingQuestions = new Map<string, PendingOpenCodeForm>();
  private readonly nativeAgentFence = new NativeAgentFenceSlot('opencode-sdk');
  private providerToRoute = new Map<string, string>();
  private providerRouteOrder = new Map<string, string[]>();
  private modelCache: { at: number; value: ProviderModelList } | null = null;
  private modelContextWindows = new Map<string, number>();
  private modelReasoningMeta = new Map<string, OpenCodeModelReasoningMeta>();
  private lastContextWindowRefreshAt = 0;
  private contextWindowRefreshInFlight = false;
  private approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS;
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private approvalCallbacks: Array<(sessionId: string, request: ApprovalRequest) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  private usageCallbacks: Array<(sessionId: string, usage: ProviderUsageUpdate) => void> = [];

  private async startConfiguredRuntime(options: OpenCodeSdkStartOptions): Promise<OpenCodeSdkRuntimeStartResult> {
    if (this.transportResolution?.mode === OPENCODE_TRANSPORT_MODES.V2_CLI) {
      return await startOpenCodeV2CliHost({
        ...options,
        binaryPath: this.transportResolution.cli.binaryPath,
        launchPlan: this.transportResolution.cli.launchPlan,
      });
    }
    return await openCodeSdkRuntimeHooks.start(options);
  }

  private wireDelegate(delegate: Pick<OpenCodeSdkProvider,
    'onDelta' | 'onComplete' | 'onError' | 'onToolCall' | 'onApprovalRequest'
    | 'onSessionInfo' | 'onStatus' | 'onUsage'
    | 'setToolExecutionGuard' | 'setParticipantTurnResolver' | 'setNativeAgentFenceResolver'
  >): void {
    const disposers: Array<() => void> = [];
    disposers.push(delegate.onDelta((sessionId, delta) => {
      for (const cb of this.deltaCallbacks) cb(sessionId, delta);
    }));
    disposers.push(delegate.onComplete((sessionId, msg) => {
      for (const cb of this.completeCallbacks) cb(sessionId, msg);
    }));
    disposers.push(delegate.onError((sessionId, err) => {
      for (const cb of this.errorCallbacks) cb(sessionId, err);
    }));
    delegate.onToolCall((sessionId, tool) => {
      for (const cb of this.toolCallbacks) cb(sessionId, tool);
    });
    delegate.onApprovalRequest((sessionId, req) => {
      for (const cb of this.approvalCallbacks) cb(sessionId, req);
    });
    disposers.push(delegate.onSessionInfo((sessionId, info) => {
      for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
    }));
    disposers.push(delegate.onStatus((sessionId, status) => {
      for (const cb of this.statusCallbacks) cb(sessionId, status);
    }));
    disposers.push(delegate.onUsage((sessionId, usage) => {
      for (const cb of this.usageCallbacks) cb(sessionId, usage);
    }));
    if (this.toolExecutionGuard) delegate.setToolExecutionGuard(this.toolExecutionGuard);
    if (this.participantTurnResolver) delegate.setParticipantTurnResolver(this.participantTurnResolver);
    if (this.nativeAgentFenceResolver) delegate.setNativeAgentFenceResolver(this.nativeAgentFenceResolver);
    this.delegateDisposers.push(...disposers);
  }

  private delegateForSession(sessionId: string): OpenCodeV1CliProvider | OpenCodeSdkProvider | null {
    if (this.embeddedFallbackRoutes.has(sessionId) && this.embeddedFallbackDelegate) {
      return this.embeddedFallbackDelegate;
    }
    return this.v1Delegate;
  }

  private async ensureEmbeddedFallbackDelegate(): Promise<OpenCodeSdkProvider> {
    if (this.embeddedFallbackDelegate) return this.embeddedFallbackDelegate;
    if (this.embeddedFallbackConnectPromise) return await this.embeddedFallbackConnectPromise;
    const task = (async () => {
      const fallback = new OpenCodeSdkProvider();
      this.wireDelegate(fallback);
      await fallback.connect({
        ...this.connectConfig,
        transport: 'embedded',
      } as ProviderConfig);
      this.embeddedFallbackDelegate = fallback;
      return fallback;
    })();
    this.embeddedFallbackConnectPromise = task;
    try {
      return await task;
    } finally {
      if (this.embeddedFallbackConnectPromise === task) {
        this.embeddedFallbackConnectPromise = null;
      }
    }
  }

  async connect(config: ProviderConfig): Promise<void> {
    if (this.v1Delegate || (this.client && this.server)) return;
    const abort = new AbortController();
    this.lifecycleAbort = abort;
    const task = (async () => {
      const resolution = await resolveOpenCodeTransport({
        hookOverridden: openCodeSdkRuntimeHooks.start !== defaultOpenCodeSdkStart,
        config,
        signal: abort.signal,
      });
      if (abort.signal.aborted) {
        throw providerError(PROVIDER_ERROR_CODES.CANCELLED, 'OpenCode connect cancelled', true);
      }
      this.transportResolution = resolution;
      this.connectConfig = { ...config };
      this.databasePath = safeString(config.databasePath);
      this.catalogDirectory = safeString(config.cwd) ?? process.cwd();

      if (resolution.mode === OPENCODE_TRANSPORT_MODES.V1_CLI) {
        const v1 = new OpenCodeV1CliProvider({
          binaryPath: resolution.cli.binaryPath,
          launchPlan: resolution.cli.launchPlan,
        });
        this.wireDelegate(v1);
        this.v1Delegate = v1;
        try {
          await v1.connect(config, abort.signal);
          if (abort.signal.aborted) {
            await v1.disconnect().catch(() => {});
            throw providerError(PROVIDER_ERROR_CODES.CANCELLED, 'OpenCode v1 CLI connect cancelled', true);
          }
          return;
        } catch (error) {
          this.v1Delegate = null;
          for (const dispose of this.delegateDisposers) dispose();
          this.delegateDisposers = [];
          await v1.disconnect().catch(() => {});
          this.transportResolution = null;
          this.connectConfig = {};
          throw error;
        }
      }

      const port = positiveNumber(config.port) || 0;
      const timeout = positiveNumber(config.startupTimeoutMs) || 10_000;
      try {
        const started = await this.startConfiguredRuntime({
          hostname: LOOPBACK_HOST,
          port,
          timeout,
          signal: abort.signal,
          directory: this.catalogDirectory,
          warmupCatalog: true,
          hostGroupKey: this.hostGroupKey,
          ...(this.databasePath ? { databasePath: this.databasePath } : {}),
        });
        const url = new URL(started.server.url);
        if (!isLoopbackHostname(url.hostname)) {
          await Promise.resolve(started.server.close()).catch(() => {});
          throw providerError(PROVIDER_ERROR_CODES.CONFIG_ERROR, 'OpenCode SDK server did not bind to loopback', false);
        }
        if (abort.signal.aborted) {
          await Promise.resolve(started.server.close()).catch(() => {});
          throw providerError(PROVIDER_ERROR_CODES.CANCELLED, 'OpenCode connect cancelled', true);
        }
        this.client = started.client;
        this.server = started.server;
        this.approvalTimeoutMs = positiveNumber(config.approvalTimeoutMs) || DEFAULT_APPROVAL_TIMEOUT_MS;
        logger.info({ provider: this.id, server: url.origin, mode: resolution.mode }, 'OpenCode SDK provider connected');
      } catch (error) {
        abort.abort();
        await Promise.resolve(this.server?.close()).catch(() => {});
        this.server = null;
        this.client = null;
        if (this.lifecycleAbort === abort) this.lifecycleAbort = null;
        const normalized = this.normalizeError(error, 'connect');
        this.transportResolution = null;
        this.connectConfig = {};
        throw normalized;
      }
    })();
    this.connectInFlight = task;
    try {
      await task;
    } finally {
      if (this.connectInFlight === task) this.connectInFlight = null;
    }
  }

  async disconnect(): Promise<void> {
    this.lifecycleAbort?.abort();
    this.lifecycleAbort = null;
    const inflight = this.connectInFlight;
    const inflightV1 = this.v1Delegate;
    const v1DisconnectWhileConnecting = inflight && inflightV1
      ? inflightV1.disconnect().catch(() => {})
      : Promise.resolve();
    if (inflight) {
      await inflight.catch(() => {});
    }
    await v1DisconnectWhileConnecting;
    if (this.embeddedFallbackConnectPromise) {
      await this.embeddedFallbackConnectPromise.catch(() => {});
    }
    const v1 = this.v1Delegate;
    const fallback = this.embeddedFallbackDelegate;
    if (v1 || fallback || this.delegateDisposers.length > 0 || this.embeddedFallbackRoutes.size > 0) {
      this.v1Delegate = null;
      this.embeddedFallbackDelegate = null;
      this.embeddedFallbackConnectPromise = null;
      this.embeddedFallbackRoutes.clear();
      for (const dispose of this.delegateDisposers) dispose();
      this.delegateDisposers = [];
      await Promise.all([
        v1 ? v1.disconnect().catch(() => {}) : Promise.resolve(),
        fallback ? fallback.disconnect().catch(() => {}) : Promise.resolve(),
      ]);
      if (this.sessions.size === 0 && !this.server && !this.client) {
        this.transportResolution = null;
        this.connectConfig = {};
        return;
      }
    }
    const states = [...this.sessions.values()];
    this.sessions.clear();
    this.providerToRoute.clear();
    this.providerRouteOrder.clear();
    for (const state of states) await this.closeSessionState(state, true);
    this.activeClientEventSubs.clear();
    this.providerSessionLocks.clear();
    this.openCodeCredentialEpoch = 0;
    this.knownActiveOpenCodeCredId = undefined;
    this.knownActiveOpenCodeCredFingerprint = undefined;
    this.openCodeCredentialProvenanceLoaded = false;
    this.openCodeCredentialProvenanceDirty = false;
    this.seenEventIds.clear();
    this.pendingQuestions.clear();
    this.legacyImportInFlight.clear();
    await Promise.resolve(this.server?.close()).catch(() => {});
    this.server = null;
    this.client = null;
    this.transportResolution = null;
    this.connectConfig = {};
    this.modelCache = null;
    this.modelContextWindows.clear();
    this.modelReasoningMeta.clear();
    this.lastContextWindowRefreshAt = 0;
    this.contextWindowRefreshInFlight = false;
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    if (this.v1Delegate) return this.v1Delegate.getMemoryMcpStatus();
    return {
      providerId: this.id,
      status: this.client ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: Boolean(this.client),
      degradedReasons: [],
    };
  }

  private async resolveV1VsEmbeddedOwner(
    resumeId: string,
    options: { cwd?: string; openCodeStorageOwner?: SessionConfig['openCodeStorageOwner'] } = {},
  ): Promise<'v1-cli' | 'embedded' | 'missing'> {
    if (options.openCodeStorageOwner === 'embedded') {
      return 'embedded';
    }
    if (options.openCodeStorageOwner === 'v1-cli') {
      return 'v1-cli';
    }
    const embeddedCandidates = resolveOpenCodeEmbeddedDbCandidates(this.databasePath);
    const [embeddedSnap, v1Snap] = await Promise.all([
      inspectOpenCodeSqliteSession(resumeId, embeddedCandidates),
      this.v1Delegate ? this.v1Delegate.inspectSessionSnapshot(resumeId, options.cwd) : Promise.resolve(null),
    ]);
    if (!embeddedSnap && !v1Snap) return 'missing';
    if (embeddedSnap && !v1Snap) return 'embedded';
    if (!embeddedSnap && v1Snap) return 'v1-cli';
    const cmp = compareOpenCodeSessionSnapshots(
      {
        messageCount: embeddedSnap!.messageCount,
        timeUpdated: embeddedSnap!.timeUpdated,
        latestMessageTime: embeddedSnap!.latestMessageTime,
      },
      {
        messageCount: v1Snap!.messageCount,
        timeUpdated: v1Snap!.timeUpdated,
        latestMessageTime: v1Snap!.timeUpdated,
      },
    );
    return cmp > 0 ? 'embedded' : 'v1-cli';
  }

  private async isEmbeddedCopyMoreCompleteThanV2(
    client: OpenCodeClientLike,
    v2Info: OpenCodeSessionInfoLike,
    resumeId: string,
  ): Promise<boolean> {
    const embeddedCandidates = resolveOpenCodeEmbeddedDbCandidates(this.databasePath);
    const embeddedSnap = await inspectOpenCodeSqliteSession(resumeId, embeddedCandidates);
    if (!embeddedSnap) return false;
    let v2MessageCount = 0;
    let v2LatestMsgTime = 0;
    let countedMessages = false;
    if (typeof client.message?.list === 'function') {
      try {
        const res = await client.message.list({
          sessionID: resumeId,
          limit: Math.max(embeddedSnap.messageCount + 5, 100),
        });
        if (Array.isArray(res?.data)) {
          countedMessages = true;
          v2MessageCount = res.data.length;
          for (const msg of res.data) {
            const t = positiveNumber((msg as any)?.time?.completed) ?? positiveNumber((msg as any)?.time?.created) ?? 0;
            if (t > v2LatestMsgTime) v2LatestMsgTime = t;
          }
        }
      } catch {
        // Fall back to metadata timestamps if message listing is unavailable
      }
    }
    const v2Updated = positiveNumber(v2Info?.time?.updated) ?? positiveNumber(v2Info?.time?.created) ?? 0;
    if (!countedMessages) {
      return embeddedSnap.timeUpdated > v2Updated || embeddedSnap.latestMessageTime > v2Updated;
    }
    return compareOpenCodeSessionSnapshots(
      {
        messageCount: embeddedSnap.messageCount,
        timeUpdated: embeddedSnap.timeUpdated,
        latestMessageTime: embeddedSnap.latestMessageTime,
      },
      {
        messageCount: v2MessageCount,
        timeUpdated: v2Updated,
        latestMessageTime: v2LatestMsgTime,
      },
    ) > 0;
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const resumeId = safeString(config.resumeId);
    if ((!config.skipCreate || config.fresh) && this.embeddedFallbackRoutes.has(routeId)) {
      this.embeddedFallbackRoutes.delete(routeId);
      await this.embeddedFallbackDelegate?.endSession(routeId).catch(() => {});
    }

    const activeMode = this.transportResolution?.mode ?? OPENCODE_TRANSPORT_MODES.EMBEDDED;
    const recordedOwner = config.openCodeStorageOwner;
    let confirmedV1Migration: { payload: Record<string, unknown>; sourceDbPath: string } | null = null;

    // Centralized storage-owner validation for resumes BEFORE touching any incompatible runtime/store:
    // - compatible stores read directly from that store
    // - embedded owner under CLI mode reuses embeddedFallbackDelegate
    // - v1-cli owner under v2-cli/embedded verifies the v1 source DB first and only updates owner after confirmed migration
    // - v2-cli owner under v1-cli or embedded fails explicitly with CLI recovery guidance without touching embedded DB
    if (config.skipCreate && resumeId) {
      if (
        activeMode !== OPENCODE_TRANSPORT_MODES.EMBEDDED
        && (this.embeddedFallbackRoutes.has(routeId) || recordedOwner === 'embedded')
      ) {
        const fallback = await this.ensureEmbeddedFallbackDelegate();
        const restoredRoute = await fallback.createSession(config);
        this.embeddedFallbackRoutes.add(restoredRoute);
        return restoredRoute;
      }

      if (recordedOwner === 'v2-cli' && activeMode !== OPENCODE_TRANSPORT_MODES.V2_CLI) {
        const recoveryHint = activeMode === OPENCODE_TRANSPORT_MODES.V1_CLI
          ? 'OpenCode session belongs to v2 CLI storage and cannot be restored under OpenCode v1 CLI. Upgrade OpenCode CLI to v2 (`opencode upgrade --major`, or set `OPENCODE_BIN` / `binaryPath`) to resume this session.'
          : 'OpenCode session belongs to v2 CLI storage and cannot be restored in embedded OpenCode mode. Install or restore OpenCode CLI >= 2.0 (or configure `OPENCODE_BIN` / `binaryPath`) to resume this session.';
        throw providerError(PROVIDER_ERROR_CODES.CONFIG_ERROR, `${recoveryHint} (session: ${resumeId})`, false);
      }

      if (recordedOwner === 'v1-cli' && activeMode !== OPENCODE_TRANSPORT_MODES.V1_CLI) {
        try {
          confirmedV1Migration = await readLegacySessionImportPayload(
            resumeId,
            this.databasePath,
            config.cwd,
            'v1-cli',
          );
        } catch (migrationReadErr) {
          throw providerError(
            PROVIDER_ERROR_CODES.CONFIG_ERROR,
            `OpenCode session "${resumeId}" belongs to v1 CLI storage and failed migration preflight: ${errorMessage(migrationReadErr)}. Install or restore OpenCode v1 CLI (or configure \`OPENCODE_BIN\` / \`binaryPath\`, or export via \`opencode export ${resumeId}\`) to resume this session.`,
            false,
          );
        }
        if (!confirmedV1Migration) {
          throw providerError(
            PROVIDER_ERROR_CODES.CONFIG_ERROR,
            `OpenCode session "${resumeId}" belongs to v1 CLI storage, and its v1 source database could not be verified for migration. Install or restore OpenCode v1 CLI (or configure \`OPENCODE_BIN\` / \`binaryPath\`, or export via \`opencode export ${resumeId}\`) to resume this session.`,
            false,
          );
        }
      }
    }

    if (this.v1Delegate) {
      if (config.skipCreate && resumeId) {
        const resolvedOwner = await this.resolveV1VsEmbeddedOwner(resumeId, {
          cwd: config.cwd,
          openCodeStorageOwner: recordedOwner,
        });
        if (resolvedOwner === 'missing') {
          throw providerError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `OpenCode session was not found during restore: ${resumeId}`, false);
        }
        if (resolvedOwner === 'embedded') {
          const fallback = await this.ensureEmbeddedFallbackDelegate();
          const restoredRoute = await fallback.createSession(config);
          this.embeddedFallbackRoutes.add(restoredRoute);
          return restoredRoute;
        }
        return await this.v1Delegate.createSession(config);
      }
      return await this.v1Delegate.createSession(config);
    }
    this.assertConnected();
    if (!this.modelCache) await this.listModels(false);
    const existing = this.sessions.get(routeId);
    if (existing && !config.fresh) {
      if (safeString(config.agentId)) existing.model = config.agentId!.trim();
      if (config.effort) existing.effort = config.effort;
      existing.appliedModelSignature = null;
      this.emitSessionInfo(existing);
      return routeId;
    }
    if (existing) await this.endSession(routeId);

    const cwd = safeString(config.cwd) ?? process.cwd();
    const nativeAgentsFenced = this.nativeAgentFence.required(routeId, config.sessionName);
    const sessionRuntime = await this.startSessionRuntime(config, cwd, nativeAgentsFenced);
    const guardTools = Boolean(this.toolExecutionGuard);
    const createPermissions = buildOpenCodeGuardedSessionPermissions(nativeAgentsFenced, guardTools);
    let info: OpenCodeSessionInfoLike;
    if (config.skipCreate && resumeId) {
      try {
        if (confirmedV1Migration) {
          info = await this.importConfirmedV1SessionIntoRuntime(
            sessionRuntime.client,
            resumeId,
            confirmedV1Migration,
          );
        } else if (recordedOwner === 'v2-cli' || recordedOwner === 'embedded') {
          info = await sessionRuntime.client.sessions.get({ sessionID: resumeId });
        } else {
          info = await this.ensureSessionPresentOrImportLegacy(
            sessionRuntime.client,
            resumeId,
            cwd,
          );
          if (
            activeMode === OPENCODE_TRANSPORT_MODES.V2_CLI
            && await this.isEmbeddedCopyMoreCompleteThanV2(sessionRuntime.client, info, resumeId)
          ) {
            await this.closeStartedRuntime(sessionRuntime);
            const fallback = await this.ensureEmbeddedFallbackDelegate();
            const restoredRoute = await fallback.createSession(config);
            this.embeddedFallbackRoutes.add(restoredRoute);
            return restoredRoute;
          }
        }
        if ((nativeAgentsFenced || guardTools) && typeof sessionRuntime.client.session?.update === 'function') {
          await sessionRuntime.client.session.update({
            sessionID: info.id,
            permissions: mergeOpenCodeFencedPermissions(info.permissions, nativeAgentsFenced, guardTools),
          });
        }
      } catch (error) {
        await this.closeStartedRuntime(sessionRuntime);
        throw this.normalizeError(error, 'restore');
      }
    } else {
      try {
        info = await sessionRuntime.client.sessions.create({
          location: { directory: cwd },
          title: safeString(config.label) ?? config.sessionName ?? config.sessionKey,
          ...(createPermissions.length > 0 ? { permissions: createPermissions } : {}),
        });
      } catch (error) {
        await this.closeStartedRuntime(sessionRuntime);
        throw this.normalizeError(error, 'create');
      }
    }
    const providerSessionId = safeString(info?.id);
    if (!providerSessionId) {
      await this.closeStartedRuntime(sessionRuntime);
      throw providerError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'OpenCode did not return a session ID', false);
    }
    const explicitModel = safeString(config.agentId);
    const hasDefaultOpenCodeModel = Boolean(
      this.modelCache?.value.models.some((model) => model.id === DEFAULT_OPENCODE_MODEL_ID),
    );
    const initialModel = explicitModel ?? (!config.skipCreate && hasDefaultOpenCodeModel ? DEFAULT_OPENCODE_MODEL_ID : undefined);
    const state: OpenCodeSessionState = {
      routeId,
      providerSessionId,
      cwd,
      model: initialModel,
      effort: config.effort,
      appliedModelSignature: null,
      syncedMcpSignature: null,
      busy: false,
      compacting: false,
      compactRequest: null,
      compactCompletionEmitted: false,
      generation: 0,
      cancelled: false,
      completionEmitted: false,
      terminalErrorEmitted: false,
      authHealInFlight: false,
      authHealPhase: 'none',
      authHealRetryAcked: false,
      priorAttemptAssistantIds: new Set(),
      priorAttemptUserMessageIds: new Set(),
      openCodeCredSwitchedDuringTurn: false,
      openCodeCredChangedIdsDuringTurn: new Set(),
      retryTerminalReconcileInFlight: false,
      retryTerminalHint: null,
      retryTerminalError: undefined,
      retryActivitySeq: 0,
      retryReconcileToken: 0,
      pendingAdmissionAbort: null,
      activeTurnParams: null,
      missingFinalRecoveryAttempted: false,
      missingFinalRecoveryInFlight: false,
      cronControlActive: false,
      silentToolResult: null,
      deliveryMessageId: null,
      currentMessageId: null,
      textParts: new Map(),
      toolNames: new Map(),
      toolInputs: new Map(),
      toolSignatures: new Map(),
      surfacedQuestionCallIds: new Set(),
      lastUsageSignature: null,
      lastUsage: undefined,
      lastUsageMessageId: null,
      client: sessionRuntime.client,
      server: sessionRuntime.server,
      abort: sessionRuntime.abort,
      ensureEvents: sessionRuntime.ensureEvents,
      releaseEvents: sessionRuntime.releaseEvents,
      bindSessionMcp: sessionRuntime.bindSessionMcp,
      unbindSessionMcp: sessionRuntime.unbindSessionMcp,
      pendingPermissions: new Map(),
      runtimeConfig: { ...config },
      nativeAgentFence: fenceOf(nativeAgentsFenced),
    };
    const preLockOwnerId = this.providerToRoute.get(providerSessionId);
    const preLockOwner = preLockOwnerId ? this.sessions.get(preLockOwnerId) : undefined;
    const preLockOwnerWasBusy = Boolean(preLockOwner && preLockOwner !== state && preLockOwner.busy);
    if (preLockOwner && preLockOwner !== state) {
      preLockOwner.pendingAdmissionAbort?.abort();
    }
    await this.withProviderSessionLock(providerSessionId, async () => {
      this.sessions.set(routeId, state);
      const previousOwnerId = this.providerToRoute.get(providerSessionId);
      const previousOwner = previousOwnerId ? this.sessions.get(previousOwnerId) : undefined;
      if (previousOwner && previousOwner !== state) {
        previousOwner.syncedMcpSignature = null;
        previousOwner.pendingAdmissionAbort?.abort();
        if (previousOwner.busy || preLockOwnerWasBusy) {
          const interruptResult = await this.interruptRouteWithDeadline(previousOwner, 'ownership transfer interrupt');
          if (interruptResult.ok) {
            previousOwner.cancelled = true;
            previousOwner.generation += 1;
            this.failOnce(
              previousOwner,
              providerError(
                PROVIDER_ERROR_CODES.CANCELLED,
                `OpenCode route "${previousOwner.routeId}" turn cancelled because ownership transferred to "${routeId}"`,
                true,
              ),
            );
          } else {
            const reclaimed = await this.stopAndReclaimExclusiveRoute(
              previousOwner,
              sessionRuntime.server,
              sessionRuntime.client,
            );
            if (!reclaimed) {
              throw providerError(
                PROVIDER_ERROR_CODES.CONNECTION_LOST,
                `Timed out interrupting active OpenCode route "${previousOwner.routeId}" before ownership transfer`,
                true,
              );
            }
          }
        }
      }
      // Suspend previous owner executability before binding replacement MCP so no suspended send can clobber MCP during handoff.
      this.providerToRoute.delete(providerSessionId);
      try {
        await this.syncSessionMcp(state);
      } catch (error) {
        this.sessions.delete(routeId);
        if (previousOwner && this.sessions.get(previousOwner.routeId) === previousOwner) {
          previousOwner.syncedMcpSignature = null;
          await this.syncSessionMcp(previousOwner).catch(() => {});
          if (this.sessions.get(previousOwner.routeId) === previousOwner) {
            this.providerToRoute.set(providerSessionId, previousOwner.routeId);
          }
        }
        const remaining = (this.providerRouteOrder.get(providerSessionId) ?? [])
          .filter((id) => id !== routeId && this.sessions.get(id)?.providerSessionId === providerSessionId);
        if (remaining.length > 0) this.providerRouteOrder.set(providerSessionId, remaining);
        else this.providerRouteOrder.delete(providerSessionId);
        throw this.normalizeError(error, 'mcp startup');
      }
      this.registerProviderRoute(providerSessionId, routeId);
      if (state.model || state.effort) {
        await this.syncSessionModelAndEffort(state).catch(() => {});
      }
    }).catch(async (error) => {
      if (this.sessions.get(routeId) === state) this.sessions.delete(routeId);
      await this.closeSessionState(state, !this.providerToRoute.has(providerSessionId));
      throw error;
    });
    this.emitSessionInfo(state);
    return routeId;
  }

  private isExclusiveRuntimeChild(
    targetState: OpenCodeSessionState,
    incomingServer?: OpenCodeServerLike,
    incomingClient?: OpenCodeClientLike,
  ): boolean {
    if (targetState.server === this.server) return false;
    if (incomingServer && targetState.server === incomingServer) return false;
    if (incomingClient && targetState.client === incomingClient) return false;
    const checkUrlSharing = this.transportResolution?.mode === OPENCODE_TRANSPORT_MODES.V2_CLI;
    if (checkUrlSharing && incomingServer && targetState.server.url === incomingServer.url) {
      return false;
    }
    for (const other of this.sessions.values()) {
      if (other === targetState) continue;
      if (
        other.server === targetState.server
        || other.client === targetState.client
        || (checkUrlSharing && other.server.url === targetState.server.url)
      ) {
        return false;
      }
    }
    return true;
  }

  private async interruptRouteWithDeadline(
    state: OpenCodeSessionState,
    operation: string,
  ): Promise<{ ok: true } | { ok: false; timedOut: boolean; error: unknown }> {
    const controller = new AbortController();
    try {
      await withOpenCodeRequestTimeout(
        invokeWithOptionalSignal(
          state.client.session.interrupt.bind(state.client.session),
          { sessionID: state.providerSessionId },
          controller.signal,
        ),
        operation,
        controller,
        INTERRUPT_RPC_TIMEOUT_MS,
      );
      return { ok: true };
    } catch (error) {
      if (isNotFoundError(error)) return { ok: true };
      const timedOut = error instanceof OpenCodeRequestTimeoutError || (error instanceof Error && error.name === 'AbortError');
      return { ok: false, timedOut, error };
    }
  }

  private async stopAndReclaimExclusiveRoute(
    previousOwner: OpenCodeSessionState,
    incomingServer: OpenCodeServerLike,
    incomingClient: OpenCodeClientLike,
  ): Promise<boolean> {
    if (!this.isExclusiveRuntimeChild(previousOwner, incomingServer, incomingClient)) {
      return false;
    }
    const prevCancelled = previousOwner.cancelled;
    previousOwner.cancelled = true;
    previousOwner.generation += 1;
    try {
      await withOpenCodeRequestTimeout(
        this.closeSessionState(previousOwner, false, false),
        'exclusive route close',
        undefined,
        CHILD_CLOSE_TIMEOUT_MS,
      );
    } catch (error) {
      previousOwner.cancelled = prevCancelled;
      logger.warn(
        { provider: this.id, routeId: previousOwner.routeId, providerSessionId: previousOwner.providerSessionId, error },
        'Failed to stop exclusive OpenCode child after interrupt timeout',
      );
      return false;
    }
    if (this.sessions.get(previousOwner.routeId) === previousOwner) {
      this.sessions.delete(previousOwner.routeId);
    }
    const remaining = (this.providerRouteOrder.get(previousOwner.providerSessionId) ?? [])
      .filter((id) => id !== previousOwner.routeId && this.sessions.get(id)?.providerSessionId === previousOwner.providerSessionId);
    if (remaining.length > 0) this.providerRouteOrder.set(previousOwner.providerSessionId, remaining);
    else this.providerRouteOrder.delete(previousOwner.providerSessionId);
    if (this.providerToRoute.get(previousOwner.providerSessionId) === previousOwner.routeId) {
      this.providerToRoute.delete(previousOwner.providerSessionId);
    }
    this.failOnce(
      previousOwner,
      providerError(
        PROVIDER_ERROR_CODES.CANCELLED,
        `OpenCode route "${previousOwner.routeId}" stopped and reclaimed after interrupt timeout`,
        true,
      ),
    );
    return true;
  }

  private async importConfirmedV1SessionIntoRuntime(
    client: OpenCodeClientLike,
    sessionId: string,
    legacy: { payload: Record<string, unknown>; sourceDbPath: string },
  ): Promise<OpenCodeSessionInfoLike> {
    if (typeof client.experimental?.session?.import !== 'function') {
      throw providerError(
        PROVIDER_ERROR_CODES.CONFIG_ERROR,
        `OpenCode session "${sessionId}" belongs to v1 CLI storage and cannot be migrated automatically in this runtime. Install or restore OpenCode v1 CLI (or configure \`OPENCODE_BIN\` / \`binaryPath\`, or export via \`opencode export ${sessionId}\`) to resume this session.`,
        false,
      );
    }
    try {
      const imported = await client.experimental.session.import(legacy.payload);
      logger.info(
        { provider: this.id, sessionId, sourceDbPath: legacy.sourceDbPath },
        'Migrated v1-cli OpenCode session from confirmed v1 source before owner update',
      );
      if (safeString(imported?.id) === sessionId) return imported;
      return await client.sessions.get({ sessionID: sessionId });
    } catch (importErr) {
      throw providerError(
        PROVIDER_ERROR_CODES.CONFIG_ERROR,
        `Failed to migrate v1-cli OpenCode session "${sessionId}" from ${legacy.sourceDbPath}: ${errorMessage(importErr)}. Install or restore OpenCode v1 CLI (or configure \`OPENCODE_BIN\` / \`binaryPath\`, or export via \`opencode export ${sessionId}\`) without modifying target storage.`,
        false,
      );
    }
  }

  private async closeOrDetachRoute(sessionId: string, interruptBusyOwner: boolean): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const preLockWasBusy = Boolean(interruptBusyOwner && state.busy);
    state.pendingAdmissionAbort?.abort();
    let removedSoleProviderRoute = false;
    await this.withProviderSessionLock(state.providerSessionId, async () => {
      if (this.sessions.get(sessionId) !== state) return;
      state.pendingAdmissionAbort?.abort();
      state.authHealInFlight = false;
      state.authHealPhase = 'none';
      state.activeTurnParams = null;
      state.generation += 1;
      this.sessions.delete(state.routeId);
      const wasOwner = this.providerToRoute.get(state.providerSessionId) === state.routeId;
      const remainingRoutes = (this.providerRouteOrder.get(state.providerSessionId) ?? [])
        .filter((routeId) => (
          routeId !== state.routeId
          && this.sessions.get(routeId)?.providerSessionId === state.providerSessionId
        ));
      if (remainingRoutes.length > 0) this.providerRouteOrder.set(state.providerSessionId, remainingRoutes);
      else this.providerRouteOrder.delete(state.providerSessionId);

      removedSoleProviderRoute = wasOwner && remainingRoutes.length === 0;
      if (interruptBusyOwner && (state.busy || preLockWasBusy) && removedSoleProviderRoute) {
        const res = await this.interruptRouteWithDeadline(state, 'session close interrupt');
        if (!res.ok) {
          logger.warn(
            { provider: this.id, sessionId: state.routeId, providerSessionId: state.providerSessionId, error: res.error },
            'OpenCode session interrupt failed/timed out during close; proceeding to child close',
          );
        }
      }
      if (wasOwner) {
        // Withdraw ownership BEFORE restoring fallback MCP so fallback route cannot send with stale MCP binding.
        this.providerToRoute.delete(state.providerSessionId);
        if (remainingRoutes.length > 0) {
          const fallbackRouteId = remainingRoutes[remainingRoutes.length - 1]!;
          const fallbackState = this.sessions.get(fallbackRouteId);
          if (fallbackState && this.sessions.get(fallbackRouteId) === fallbackState) {
            fallbackState.syncedMcpSignature = null;
            await this.syncSessionMcp(fallbackState).catch(() => {});
            if (this.sessions.get(fallbackRouteId) === fallbackState) {
              this.providerToRoute.set(state.providerSessionId, fallbackRouteId);
            }
          }
        } else if (state.unbindSessionMcp) {
          await state.unbindSessionMcp(state.providerSessionId).catch(() => {});
        }
      }
    });
    await this.closeSessionState(state, false);
  }

  async endSession(sessionId: string): Promise<void> {
    const delegate = this.delegateForSession(sessionId);
    if (delegate) {
      this.embeddedFallbackRoutes.delete(sessionId);
      return await delegate.endSession(sessionId);
    }
    await this.closeOrDetachRoute(sessionId, true);
  }

  async detachSession(sessionId: string): Promise<void> {
    const delegate = this.delegateForSession(sessionId);
    if (delegate) {
      this.embeddedFallbackRoutes.delete(sessionId);
      return await delegate.detachSession(sessionId);
    }
    await this.closeOrDetachRoute(sessionId, false);
  }

  private async ensureSessionPresentOrImportLegacy(
    client: OpenCodeClientLike,
    sessionId: string,
    directoryHint?: string,
    preferredOwner?: SessionConfig['openCodeStorageOwner'],
  ): Promise<OpenCodeSessionInfoLike> {
    try {
      return await client.sessions.get({ sessionID: sessionId });
    } catch (error) {
      if (!isNotFoundError(error) || typeof client.experimental?.session?.import !== 'function') {
        throw error;
      }
      const inFlight = this.legacyImportInFlight.get(sessionId);
      const importTask = inFlight ?? (async () => {
        const legacy = await readLegacySessionImportPayload(sessionId, this.databasePath, directoryHint, preferredOwner);
        if (!legacy) return null;
        try {
          const imported = await client.experimental!.session!.import!(legacy.payload);
          logger.info(
            { provider: this.id, sessionId, sourceDbPath: legacy.sourceDbPath },
            'Imported legacy OpenCode v1 session into OpenCode v2 SQLite store',
          );
          return imported;
        } catch (importErr) {
          throw providerError(
            PROVIDER_ERROR_CODES.CONFIG_ERROR,
            `Failed to import legacy OpenCode v1 session "${sessionId}" from ${legacy.sourceDbPath}: ${errorMessage(importErr)}. Export the session via \`opencode export ${sessionId}\` or upgrade with \`opencode upgrade --major\`.`,
            false,
          );
        }
      })().finally(() => {
        if (this.legacyImportInFlight.get(sessionId) === importTask) {
          this.legacyImportInFlight.delete(sessionId);
        }
      });
      if (!inFlight) this.legacyImportInFlight.set(sessionId, importTask);

      let imported: OpenCodeSessionInfoLike | null;
      try {
        imported = await importTask;
      } catch (migrationErr) {
        if (migrationErr && typeof migrationErr === 'object' && 'code' in migrationErr) {
          throw migrationErr;
        }
        throw providerError(PROVIDER_ERROR_CODES.CONFIG_ERROR, errorMessage(migrationErr), false);
      }
      if (!imported) throw error;
      return await client.sessions.get({ sessionID: sessionId });
    }
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    if (this.v1Delegate) {
      const owner = await this.resolveV1VsEmbeddedOwner(sessionId, { cwd: this.catalogDirectory });
      if (owner === 'missing') return false;
      if (owner === 'embedded') {
        const fallback = await this.ensureEmbeddedFallbackDelegate();
        return await fallback.restoreSession(sessionId);
      }
      return await this.v1Delegate.restoreSession(sessionId);
    }
    const client = this.assertConnected();
    try {
      const session = await this.ensureSessionPresentOrImportLegacy(client, sessionId, this.catalogDirectory);
      return safeString(session?.id) === sessionId;
    } catch (error) {
      if (
        this.transportResolution?.mode === OPENCODE_TRANSPORT_MODES.V2_CLI
        && isNotFoundError(error)
        && await inspectOpenCodeSqliteSession(sessionId, resolveOpenCodeEmbeddedDbCandidates(this.databasePath))
      ) {
        const fallback = await this.ensureEmbeddedFallbackDelegate();
        return await fallback.restoreSession(sessionId);
      }
      if (!isNotFoundError(error)) {
        logger.warn({ provider: this.id, sessionId, error }, 'OpenCode restoreSession failed');
      }
      return false;
    }
  }

  async listSessions(options: RemoteSessionListOptions = {}): Promise<RemoteSessionInfo[]> {
    if (this.v1Delegate) return this.v1Delegate.listSessions(options);
    const client = this.assertConnected();
    const directory = safeString(options.directory);
    const result = await client.session.list(directory ? { directory } : undefined);
    const rows = Array.isArray(result?.data) ? result.data : [];
    return rows.map((session) => {
      const displayName = safeString(session.title);
      const dir = safeString(session.location?.directory);
      const updatedAt = positiveNumber(session.time?.updated);
      return {
        key: String(session.id),
        ...(displayName ? { displayName } : {}),
        ...(dir ? { directory: dir } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      };
    });
  }

  async listModels(force = false): Promise<ProviderModelList> {
    if (this.v1Delegate) return this.v1Delegate.listModels(force);
    if (!force && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_TTL_MS) {
      return this.modelCache.value;
    }
    try {
      const client = this.assertConnected();
      const location = { directory: this.catalogDirectory };
      const [providersRes, modelsRes, defaultRes] = await Promise.all([
        client.provider.list({ location }),
        client.model.list({ location }),
        client.model.default({ location }).catch(() => ({ location, data: null })),
      ]);
      const activeProviders = (Array.isArray(providersRes?.data) ? providersRes.data : [])
        .filter((provider) => provider.activation !== 'disabled');
      const providerNames = new Map(activeProviders.map((provider) => [provider.id, provider.name || provider.id]));
      const rawModels = Array.isArray(modelsRes?.data) ? modelsRes.data : [];
      const nextContextWindows = new Map<string, number>();
      const nextReasoningMeta = new Map<string, OpenCodeModelReasoningMeta>();
      const models = rawModels
        .filter((model) => model && model.enabled !== false && (!model.type || model.type === 'chat'))
        .map((model) => {
          const id = `${model.providerID}/${model.modelID}`;
          const providerName = providerNames.get(model.providerID) ?? model.providerID;
          const contextWindow = positiveNumber(model.limit?.context);
          if (contextWindow !== undefined && contextWindow > 0) nextContextWindows.set(id, contextWindow);
          const reasoningMeta = extractModelReasoningMeta(model as unknown as Record<string, any>);
          nextReasoningMeta.set(id, reasoningMeta);
          return {
            id,
            name: `${providerName} · ${model.name ?? model.modelID}`,
            ...(reasoningMeta.supportsReasoning ? { supportsReasoningEffort: true } : {}),
            ...(reasoningMeta.supportedEffortLevels ? { supportedEffortLevels: reasoningMeta.supportedEffortLevels } : {}),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      const defaultModelData = defaultRes?.data;
      const sdkDefaultModel = defaultModelData?.providerID && defaultModelData?.modelID
        ? `${defaultModelData.providerID}/${defaultModelData.modelID}`
        : undefined;
      const defaultModel = models.some((model) => model.id === DEFAULT_OPENCODE_MODEL_ID)
        ? DEFAULT_OPENCODE_MODEL_ID
        : (sdkDefaultModel ?? models[0]?.id);
      const isAuthenticated = activeProviders.length > 0 || models.length > 0;
      const value: ProviderModelList = {
        models,
        isAuthenticated,
        ...(defaultModel ? { defaultModel } : {}),
        ...(!isAuthenticated ? { error: 'OpenCode has no connected model provider' } : {}),
      };
      // Merge rather than replace so an authoritative window, once learned,
      // survives a later cold/partial/failed refresh or a transient provider
      // disconnect. disconnect() clears the map when the provider closes.
      for (const [id, windowTokens] of nextContextWindows) this.modelContextWindows.set(id, windowTokens);
      for (const [id, meta] of nextReasoningMeta) this.modelReasoningMeta.set(id, meta);
      if (isAuthenticated) {
        this.modelCache = { at: Date.now(), value };
      }
      return value;
    } catch (error) {
      return { models: [], isAuthenticated: false, error: errorMessage(error) };
    }
  }

  /**
   * When a live usage frame cannot resolve its model's window, force one
   * throttled catalog refetch so the next frame carries the authoritative
   * limit instead of the UI's 1M fallback. No-op once the window is known.
   */
  private scheduleContextWindowRefresh(model: string): void {
    if (this.modelContextWindows.has(model)) return;
    if (this.contextWindowRefreshInFlight) return;
    const now = Date.now();
    if (now - this.lastContextWindowRefreshAt < CONTEXT_WINDOW_REFRESH_MIN_INTERVAL_MS) return;
    this.lastContextWindowRefreshAt = now;
    this.contextWindowRefreshInFlight = true;
    void this.listModels(true)
      .catch(() => {})
      .finally(() => { this.contextWindowRefreshInFlight = false; });
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const delegate = this.delegateForSession(sessionId);
    if (delegate) {
      delegate.setSessionAgentId(sessionId, agentId);
      return;
    }
    const state = this.sessions.get(sessionId);
    if (!state || !agentId.trim()) return;
    state.model = agentId.trim();
    state.appliedModelSignature = null;
    this.emitSessionInfo(state);
  }

  setSessionEffort(sessionId: string, effort: TransportEffortLevel): void {
    const delegate = this.delegateForSession(sessionId);
    if (delegate) {
      delegate.setSessionEffort(sessionId, effort);
      return;
    }
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.effort = effort;
    state.appliedModelSignature = null;
    this.emitSessionInfo(state);
  }

  private resolvePromptVariant(state: OpenCodeSessionState): string | undefined {
    const effort = state.effort;
    if (!effort) return undefined;
    const modelId = state.model ?? this.modelCache?.value.defaultModel;
    const meta = modelId ? this.modelReasoningMeta.get(modelId) : undefined;
    if (!meta || !meta.supportsReasoning) return undefined;
    if (meta.variantKeys.length > 0) {
      if (meta.variantKeys.includes(effort)) return effort;
      if (meta.supportedEffortLevels && meta.supportedEffortLevels.length > 0) {
        const clamped = clampTransportEffort(effort, meta.supportedEffortLevels);
        if (clamped && meta.variantKeys.includes(clamped)) return clamped;
      }
      return undefined;
    }
    return clampTransportEffort(effort, OPENCODE_SDK_EFFORT_LEVELS);
  }

  private async syncSessionModelAndEffort(state: OpenCodeSessionState): Promise<void> {
    const targetModelId = state.model ?? (state.effort ? this.modelCache?.value.defaultModel : undefined);
    const parsed = parseModelIdentity(targetModelId);
    if (!parsed) return;
    const variant = this.resolvePromptVariant(state);
    const sig = `${parsed.providerID}/${parsed.modelID}:${variant ?? ''}`;
    if (state.appliedModelSignature === sig) return;
    await state.client.session.switchModel({
      sessionID: state.providerSessionId,
      model: {
        providerID: parsed.providerID,
        id: parsed.modelID,
        ...(variant ? { variant } : {}),
      },
    });
    state.appliedModelSignature = sig;
  }

  private async syncSessionMcp(state: OpenCodeSessionState): Promise<void> {
    const mcpServers = getDefaultMcpServers(state.runtimeConfig);
    const mcpServersConfig: Record<string, OpenCodeMcpServerSpec> = Object.fromEntries(
      Object.entries(mcpServers).map(([name, server]) => [name, {
        type: 'local',
        command: [server.command, ...server.args],
        environment: server.env,
        disabled: false,
      }]),
    );
    const signature = JSON.stringify(mcpServersConfig);
    if (state.syncedMcpSignature === signature) return;
    if (state.bindSessionMcp) {
      await state.bindSessionMcp(state.providerSessionId, state.cwd, mcpServersConfig);
    } else {
      await applyOpenCodeDirectoryMcpServers(state.client, state.cwd, mcpServersConfig);
    }
    state.syncedMcpSignature = signature;
  }

  private async applySystemInstruction(state: OpenCodeSessionState, system: string | undefined): Promise<void> {
    const entryApi = state.client.experimental?.session?.instructions?.entry;
    if (!entryApi) return;
    if (system) {
      await entryApi.put({
        sessionID: state.providerSessionId,
        key: IMCODES_SYSTEM_INSTRUCTION_KEY,
        value: system,
      });
      return;
    }
    try {
      await entryApi.remove({
        sessionID: state.providerSessionId,
        key: IMCODES_SYSTEM_INSTRUCTION_KEY,
      });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  private async withProviderSessionLock<T>(providerSessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.providerSessionLocks.get(providerSessionId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const marker = run.then(() => undefined, () => undefined);
    this.providerSessionLocks.set(providerSessionId, marker);
    try {
      return await run;
    } finally {
      if (this.providerSessionLocks.get(providerSessionId) === marker) {
        this.providerSessionLocks.delete(providerSessionId);
      }
    }
  }

  private isRouteOwner(state: OpenCodeSessionState): boolean {
    return this.sessions.get(state.routeId) === state
      && this.providerToRoute.get(state.providerSessionId) === state.routeId;
  }

  private assertRouteOwner(state: OpenCodeSessionState): void {
    if (!this.isRouteOwner(state)) {
      throw providerError(
        PROVIDER_ERROR_CODES.SESSION_NOT_FOUND,
        `OpenCode route "${state.routeId}" is no longer the active owner of session "${state.providerSessionId}"`,
        false,
      );
    }
  }

  async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    const delegate = this.delegateForSession(sessionId);
    if (delegate) return delegate.send(sessionId, payloadOrMessage, attachments, extraSystemPrompt);
    const state = this.sessions.get(sessionId);
    if (!state) throw providerError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown OpenCode SDK session: ${sessionId}`, false);
    this.assertRouteOwner(state);
    if (state.busy) throw providerError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'OpenCode session is already busy', true);

    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    if (isSessionControlCommandText(payload.userMessage, 'compact')) {
      await this.compactSession(state);
      return;
    }
    const generation = ++state.generation;
    state.busy = true;
    state.compacting = false;
    state.compactRequest = null;
    state.compactCompletionEmitted = false;
    state.cancelled = false;
    state.completionEmitted = false;
    state.terminalErrorEmitted = false;
    state.authHealInFlight = false;
    state.authHealPhase = 'none';
    state.authHealRetryAcked = false;
    state.priorAttemptAssistantIds.clear();
    state.priorAttemptUserMessageIds.clear();
    state.openCodeCredSwitchedDuringTurn = false;
    state.openCodeCredChangedIdsDuringTurn.clear();
    state.activeStepProviderId = undefined;
    state.activeTurnParams = null;
    state.missingFinalRecoveryAttempted = false;
    state.missingFinalRecoveryInFlight = false;
    state.cronControlActive = payload.assembledMessage.includes(CRON_CONTROL_PROTOCOL.OPEN_TAG);
    state.silentToolResult = null;
    state.deliveryMessageId = null;
    state.currentMessageId = null;
    state.textParts.clear();
    state.toolNames.clear();
    state.toolInputs.clear();
    state.toolSignatures.clear();
    state.lastUsageSignature = null;
    state.lastUsage = undefined;
    state.lastUsageMessageId = null;
    this.emitStatus(state.routeId, { status: 'working', label: 'OpenCode is working…' });

    const files = promptFiles(payload.attachments);
    const system = composeProviderSystemText(payload);
    const messageId = openCodePromptMessageId(state.providerSessionId, payload.deliveryId);
    state.deliveryMessageId = messageId;
    state.retryTerminalReconcileInFlight = false;
    state.retryTerminalHint = null;
    try {
      await state.ensureEvents();
      this.assertRouteOwner(state);
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      if (!this.openCodeCredentialProvenanceLoaded || this.openCodeCredentialProvenanceDirty) {
        await this.refreshOpenCodeCredentialProvenance(state.client);
        this.assertRouteOwner(state);
        if (!this.isCurrent(state, generation) || state.cancelled) return;
      }
      state.activeTurnParams = {
        generation,
        text: payload.assembledMessage,
        files,
        ...(system ? { system } : {}),
        messageId,
        startedAt: Date.now(),
        credEpochAtDispatch: this.openCodeCredentialEpoch,
        expectedCredIdAtDispatch: this.knownActiveOpenCodeCredId,
        expectedCredFingerprintAtDispatch: this.knownActiveOpenCodeCredFingerprint,
        authHealAttempted: false,
      };
      if (await this.hasAcceptedPrompt(state, messageId)) {
        return;
      }
      this.assertRouteOwner(state);
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      await this.withProviderSessionLock(state.providerSessionId, async () => {
        this.assertRouteOwner(state);
        if (!this.isCurrent(state, generation) || state.cancelled) return;
        await this.syncSessionMcp(state);
        this.assertRouteOwner(state);
        if (!this.isCurrent(state, generation) || state.cancelled) return;
        await this.syncSessionModelAndEffort(state);
        this.assertRouteOwner(state);
        if (!this.isCurrent(state, generation) || state.cancelled) return;
        await this.applySystemInstruction(state, system);
        this.assertRouteOwner(state);
        if (!this.isCurrent(state, generation) || state.cancelled) return;
        const admissionAbort = new AbortController();
        state.pendingAdmissionAbort = admissionAbort;
        try {
          await withOpenCodeRequestTimeout(
            invokeWithOptionalSignal(
              state.client.sessions.prompt,
              {
                sessionID: state.providerSessionId,
                id: messageId,
                text: payload.assembledMessage,
                ...(files.length > 0 ? { files } : {}),
              },
              admissionAbort.signal,
            ),
            'prompt submission',
            admissionAbort,
          );
        } finally {
          if (state.pendingAdmissionAbort === admissionAbort) {
            state.pendingAdmissionAbort = null;
          }
        }
      });
    } catch (error) {
      this.assertRouteOwner(state);
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      if (isTransientRequestFailure(error)) {
        try {
          const acceptance = await this.waitForPromptAcceptance(state, generation, messageId);
          this.assertRouteOwner(state);
          if (acceptance === 'accepted' || !this.isCurrent(state, generation) || state.cancelled) return;
          if (acceptance === 'unknown') {
            logger.warn(
              { provider: this.id, sessionId: state.routeId, messageId },
              'OpenCode prompt acceptance remained unknown after transient lookup failures; retrying with the same message ID',
            );
          }
        } catch (acceptanceError) {
          state.busy = false;
          state.activeTurnParams = null;
          this.emitStatus(state.routeId, { status: null, label: null });
          throw this.normalizeError(acceptanceError, 'prompt acceptance check');
        }
      }
      state.busy = false;
      state.activeTurnParams = null;
      this.emitStatus(state.routeId, { status: null, label: null });
      throw this.normalizeError(error, 'prompt submission');
    }
  }

  private async compactSession(state: OpenCodeSessionState): Promise<void> {
    const compact = typeof state.client.session?.compact === 'function'
      ? state.client.session.compact.bind(state.client.session)
      : undefined;
    if (!compact) {
      const error = providerError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        'OpenCode compact failed: SDK session.compact is unavailable',
        false,
      );
      this.emitError(state.routeId, error);
      throw error;
    }

    const generation = ++state.generation;
    const compactInputId = openCodeCompactInputId(state.providerSessionId);
    state.busy = true;
    state.compacting = true;
    state.compactRequest = {
      generation,
      inputId: compactInputId,
      startedInputId: null,
      manualStarted: false,
      sawV2Compaction: false,
    };
    state.compactCompletionEmitted = false;
    state.cancelled = false;
    state.completionEmitted = false;
    state.terminalErrorEmitted = false;
    state.authHealInFlight = false;
    state.activeTurnParams = null;
    this.emitStatus(state.routeId, { status: 'compacting', label: 'Compacting conversation...' });

    try {
      await state.ensureEvents();
      this.assertRouteOwner(state);
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      await this.withProviderSessionLock(state.providerSessionId, async () => {
        this.assertRouteOwner(state);
        if (!this.isCurrent(state, generation) || state.cancelled) return;
        await this.syncSessionModelAndEffort(state);
        this.assertRouteOwner(state);
        if (!this.isCurrent(state, generation) || state.cancelled) return;
        const admissionAbort = new AbortController();
        state.pendingAdmissionAbort = admissionAbort;
        let result: Record<string, unknown>;
        try {
          result = await withOpenCodeRequestTimeout(
            invokeWithOptionalSignal(
              compact,
              { sessionID: state.providerSessionId, id: compactInputId },
              admissionAbort.signal,
            ),
            'compact',
            admissionAbort,
          );
        } finally {
          if (state.pendingAdmissionAbort === admissionAbort) {
            state.pendingAdmissionAbort = null;
          }
        }
        const resolvedInputId = safeString((result as Record<string, unknown> | undefined)?.id);
        if (
          resolvedInputId
          && resolvedInputId !== state.compactRequest?.inputId
          && this.isCurrent(state, generation)
          && state.compactRequest
          && state.compactRequest.generation === generation
        ) {
          if (state.compactRequest.startedInputId && state.compactRequest.startedInputId !== resolvedInputId) {
            state.compactRequest.manualStarted = false;
            state.compactRequest.startedInputId = null;
          }
          state.compactRequest.inputId = resolvedInputId;
        }
      });
    } catch (error) {
      this.assertRouteOwner(state);
      if (!this.isCurrent(state, generation) || state.cancelled || state.compactCompletionEmitted) return;
      const normalized = this.normalizeError(error, 'compact');
      this.failOnce(state, normalized);
      throw normalized;
    }
  }

  private completeCompactOnce(state: OpenCodeSessionState, source: string): void {
    if (!state.compacting || state.compactCompletionEmitted || state.completionEmitted || state.terminalErrorEmitted || state.cancelled) {
      return;
    }
    state.compactCompletionEmitted = true;
    state.completionEmitted = true;
    state.compacting = false;
    state.compactRequest = null;
    state.busy = false;
    this.emitStatus(state.routeId, { status: null, label: null });
    const message: AgentMessage = {
      id: `${state.providerSessionId}:context-compaction:${Date.now()}`,
      sessionId: state.routeId,
      kind: 'system',
      role: 'system',
      content: 'OpenCode context compacted.',
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        provider: this.id,
        providerSessionId: state.providerSessionId,
        event: source,
        [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact',
        resumeId: state.providerSessionId,
        ...(state.model ? { model: state.model } : {}),
      },
    };
    for (const callback of this.completeCallbacks) callback(state.routeId, message);
  }

  async notifyActiveDelegation(
    sessionId: string,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    const delegate = this.delegateForSession(sessionId);
    if (delegate) return delegate.notifyActiveDelegation(sessionId, notification);
    const state = this.sessions.get(sessionId);
    if (!state?.busy || state.cancelled) return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    await state.client.sessions.prompt({
      sessionID: state.providerSessionId,
      id: notification.notificationId,
      text: notification.text,
      delivery: 'steer',
      resume: true,
    });
    // A successful prompt RPC is the irreversible provider admission ACK.
    // Do not post-check generation/idle after success: doing so would retain
    // and replay a message that OpenCode has already accepted.
    return AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED;
  }

  private readonly stopConfirmations = new ProviderStopConfirmation();

  cancelAndWait(sessionId: string): Promise<void> {
    const delegate = this.delegateForSession(sessionId);
    if (delegate) return delegate.cancelAndWait(sessionId);
    const state = this.sessions.get(sessionId);
    if (!state) return Promise.reject(new Error('OpenCode session unavailable for Stop'));
    const providerSessionId = state.providerSessionId;
    const generation = state.generation;
    const cancelledGeneration = generation + (state.busy ? 1 : 0);
    return this.stopConfirmations.confirm(state, () => this.cancel(sessionId),
      () => this.sessions.get(sessionId) === state && state.providerSessionId === providerSessionId
        && (state.generation === generation || state.generation === cancelledGeneration));
  }

  answerPendingQuestion(sessionName: string, answer: string): boolean {
    if (this.embeddedFallbackDelegate?.answerPendingQuestion(sessionName, answer)) return true;
    if (this.v1Delegate) return this.v1Delegate.answerPendingQuestion(sessionName, answer);
    for (const [routeId, state] of this.sessions) {
      if ((state.runtimeConfig.sessionName ?? routeId) !== sessionName) continue;
      const pending = this.pendingQuestions.get(routeId);
      if (!pending) return false;
      this.pendingQuestions.delete(routeId);
      const parsed = parseAskQuestionAnswers(pending.questions, answer);
      const formAnswer = formatFormAnswerRecord(pending.fields, parsed, answer);
      if (!state.client.session?.form?.reply) return false;
      void state.client.session.form.reply({
        sessionID: state.providerSessionId,
        formID: pending.requestId,
        answer: formAnswer,
      }).catch((error) => {
        logger.warn({ provider: this.id, sessionId: routeId, requestId: pending.requestId, error }, 'OpenCode form reply failed');
      });
      return true;
    }
    return false;
  }

  async cancel(sessionId: string, options?: ProviderCancelOptions): Promise<void> {
    const delegate = this.delegateForSession(sessionId);
    if (delegate) return delegate.cancel(sessionId, options);
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.clearPendingQuestion(state, true);
    state.pendingAdmissionAbort?.abort();
    if (!state.busy) return;
    const wasCompacting = state.compacting;
    state.cancelled = true;
    state.compacting = false;
    state.compactRequest = null;
    state.authHealInFlight = false;
    state.activeTurnParams = null;
    state.generation += 1;
    try {
      const interruptResult = await this.interruptRouteWithDeadline(state, 'session cancel');
      if (!interruptResult.ok) {
        if (interruptResult.timedOut) {
          logger.warn(
            { provider: this.id, sessionId: state.routeId, providerSessionId: state.providerSessionId, error: interruptResult.error },
            'OpenCode session interrupt timed out during cancel',
          );
        } else {
          throw interruptResult.error;
        }
      }
    } finally {
      this.failOnce(state, providerError(
        PROVIDER_ERROR_CODES.CANCELLED,
        options?.origin === PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG
          ? 'OpenCode was unresponsive and was automatically recovered.'
          : wasCompacting
            ? 'OpenCode compact cancelled'
            : 'OpenCode turn cancelled',
        true,
        options ? { cancelOrigin: options.origin, reason: options.reason } : undefined,
      ));
    }
  }

  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaCallbacks.push(cb);
    return () => { this.deltaCallbacks = this.deltaCallbacks.filter((item) => item !== cb); };
  }

  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeCallbacks.push(cb);
    return () => { this.completeCallbacks = this.completeCallbacks.filter((item) => item !== cb); };
  }

  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorCallbacks.push(cb);
    return () => { this.errorCallbacks = this.errorCallbacks.filter((item) => item !== cb); };
  }

  private toolExecutionGuard?: ToolExecutionGuard;
  private participantTurnResolver?: (sessionId: string) => boolean;

  setToolExecutionGuard(guard: ToolExecutionGuard): void {
    this.toolExecutionGuard = guard;
    this.v1Delegate?.setToolExecutionGuard(guard);
    this.embeddedFallbackDelegate?.setToolExecutionGuard(guard);
  }

  setParticipantTurnResolver(resolver: (sessionId: string) => boolean): void {
    this.participantTurnResolver = resolver;
    this.v1Delegate?.setParticipantTurnResolver(resolver);
    this.embeddedFallbackDelegate?.setParticipantTurnResolver(resolver);
  }

  onToolCall(cb: (sessionId: string, tool: ToolCallEvent) => void): void {
    this.toolCallbacks.push(cb);
  }

  onApprovalRequest(cb: (sessionId: string, request: ApprovalRequest) => void): void {
    this.approvalCallbacks.push(cb);
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.sessionInfoCallbacks.push(cb);
    return () => { this.sessionInfoCallbacks = this.sessionInfoCallbacks.filter((item) => item !== cb); };
  }

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.push(cb);
    return () => { this.statusCallbacks = this.statusCallbacks.filter((item) => item !== cb); };
  }

  onUsage(cb: (sessionId: string, usage: ProviderUsageUpdate) => void): () => void {
    this.usageCallbacks.push(cb);
    return () => { this.usageCallbacks = this.usageCallbacks.filter((item) => item !== cb); };
  }

  async respondApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    const delegate = this.delegateForSession(sessionId);
    if (delegate) return delegate.respondApproval(sessionId, requestId, approved);
    const state = this.sessions.get(sessionId);
    if (!state) throw providerError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown OpenCode SDK session: ${sessionId}`, false);
    this.assertRouteOwner(state);
    const timer = state.pendingPermissions.get(requestId);
    if (timer) clearTimeout(timer);
    state.pendingPermissions.delete(requestId);
    await this.replyPermission(state, requestId, approved);
  }

  private async replyPermission(
    state: OpenCodeSessionState,
    requestId: string,
    approved: boolean,
  ): Promise<void> {
    try {
      await state.client.permission.reply({
        sessionID: state.providerSessionId,
        requestID: requestId,
        decision: approved ? 'once' : 'reject',
      });
    } catch (error) {
      throw this.normalizeError(error, 'permission');
    }
  }

  private async hasAcceptedPrompt(state: OpenCodeSessionState, messageId: string): Promise<boolean> {
    try {
      const msg = await state.client.session.message.get({
        sessionID: state.providerSessionId,
        messageID: messageId,
      }) as Record<string, any> | undefined;
      return safeString(msg?.id) === messageId && msg?.type === 'user';
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  private async waitForPromptAcceptance(
    state: OpenCodeSessionState,
    generation: number,
    messageId: string,
  ): Promise<PromptAcceptance> {
    let lastObservation: PromptAcceptance = 'unknown';
    for (const delayMs of PROMPT_ACCEPTANCE_RECHECK_DELAYS_MS) {
      await sleep(delayMs);
      if (!this.isCurrent(state, generation) || state.cancelled || !this.isRouteOwner(state)) return 'unknown';
      try {
        if (await this.hasAcceptedPrompt(state, messageId)) {
          logger.warn(
            { provider: this.id, sessionId: state.routeId, messageId },
            'OpenCode prompt submission response failed after the message was accepted; suppressing duplicate replay',
          );
          return 'accepted';
        }
        lastObservation = 'absent';
      } catch (error) {
        if (!isTransientRequestFailure(error)) throw error;
        // A later failed lookup invalidates an earlier absence observation:
        // the server may have accepted the message in between. Retry remains
        // safe because every dispatch attempt reuses this exact message ID.
        lastObservation = 'unknown';
      }
    }
    return lastObservation;
  }

  private async consumeEvents(
    stream: AsyncIterable<Record<string, any>>,
    signal: AbortSignal,
    client?: OpenCodeClientLike,
    onUnexpectedExit?: (error: unknown) => void,
  ): Promise<void> {
    const iterator = stream[Symbol.asyncIterator]();
    let abortListener: (() => void) | null = null;
    try {
      // `@opencode/sdk`'s `events.subscribe` iterator can remain parked on `next()` after
      // `signal.abort()` until the shared host closes; racing the abort signal and invoking
      // `iterator.return?.()` lets `closeSessionState` and `disconnect` drain cleanly.
      const abortPromise = new Promise<{ aborted: true }>((resolveAbort) => {
        if (signal.aborted) {
          resolveAbort({ aborted: true });
          return;
        }
        abortListener = () => {
          void iterator.return?.().catch(() => {});
          resolveAbort({ aborted: true });
        };
        signal.addEventListener('abort', abortListener, { once: true });
      });

      while (!signal.aborted) {
        const step = await Promise.race([
          iterator.next().then((result) => ({ aborted: false as const, result })),
          abortPromise,
        ]);
        if (step.aborted || signal.aborted) return;
        if (step.result.done) {
          throw new Error('OpenCode event stream ended');
        }
        this.handleEvent(step.result.value, client);
      }
    } catch (error) {
      if (signal.aborted) return;
      if (onUnexpectedExit) {
        onUnexpectedExit(error);
      } else {
        const normalized = this.normalizeError(error, 'events');
        for (const state of this.sessions.values()) {
          if (!state.busy || !this.isRouteOwner(state) || (client && state.client !== client)) continue;
          this.failOnce(state, normalized);
        }
      }
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener);
      if (signal.aborted) {
        void iterator.return?.().catch(() => {});
      }
    }
  }

  setNativeAgentFenceResolver(resolver: NativeAgentFenceResolver): void {
    this.nativeAgentFenceResolver = resolver;
    this.nativeAgentFence.install(resolver);
    this.v1Delegate?.setNativeAgentFenceResolver(resolver);
    this.embeddedFallbackDelegate?.setNativeAgentFenceResolver(resolver);
  }

  /**
   * The fence of the live runtime serving this route: fixed when that runtime
   * started. A relaunch starts a new runtime and decides again.
   */
  async getNativeAgentFence(providerSessionId: string): Promise<NativeAgentFence> {
    const delegate = this.delegateForSession(providerSessionId);
    if (delegate) return delegate.getNativeAgentFence(providerSessionId);
    return this.sessions.get(providerSessionId)?.nativeAgentFence ?? NATIVE_AGENT_FENCES.PROVIDER_DEFAULT;
  }

  private async acquireClientEventSubscription(
    client: OpenCodeClientLike,
    subscribeEvents?: OpenCodeSdkRuntimeStartResult['subscribeEvents'],
    ensureHostEvents?: OpenCodeSdkRuntimeStartResult['ensureEvents'],
  ): Promise<() => Promise<void>> {
    let entry = this.activeClientEventSubs.get(client);
    if (!entry) {
      let unsubscribeUpstream: (() => Promise<void>) | null = null;
      let subHostSubscribed = false;
      const failClientBusySessions = (error: unknown) => {
        const normalized = this.normalizeError(error, 'events');
        for (const state of this.sessions.values()) {
          if (!state.busy || !this.isRouteOwner(state) || state.client !== client) continue;
          this.failOnce(state, normalized);
        }
      };

      const startFeed = async (): Promise<void> => {
        if (created.closed || this.activeClientEventSubs.get(client) !== created) return;
        if (subscribeEvents) {
          if (!subHostSubscribed) {
            unsubscribeUpstream = await subscribeEvents(
              this.providerConsumerId,
              (event) => this.handleEvent(event, client),
              (error) => {
                created.broken = true;
                this.openCodeCredentialProvenanceDirty = true;
                failClientBusySessions(error);
              },
            );
            subHostSubscribed = true;
          } else if (ensureHostEvents) {
            await ensureHostEvents();
          }
          created.broken = false;
          return;
        }
        const prevAbort = created.currentSubAbort;
        if (prevAbort && !prevAbort.signal.aborted) {
          prevAbort.abort();
        }
        const subAbort = new AbortController();
        created.currentSubAbort = subAbort;
        const subscription = await client.events.subscribe({}, { signal: subAbort.signal }) as unknown as
          | AsyncIterable<Record<string, any>>
          | { stream: AsyncIterable<Record<string, any>> };
        if (created.closed || subAbort.signal.aborted || this.activeClientEventSubs.get(client) !== created) {
          const earlyStream = 'stream' in subscription ? subscription.stream : subscription;
          void earlyStream[Symbol.asyncIterator]().return?.().catch(() => {});
          return;
        }
        const stream = 'stream' in subscription ? subscription.stream : subscription;
        const loop = this.consumeEvents(stream, subAbort.signal, client, (error) => {
          if (created.currentSubAbort === subAbort) {
            created.broken = true;
          }
          this.openCodeCredentialProvenanceDirty = true;
          failClientBusySessions(error);
          if (!created.closed && created.refCount > 0 && this.activeClientEventSubs.get(client) === created) {
            void created.ensureLive().catch((recoverErr) => {
              logger.debug({ provider: this.id, error: recoverErr }, 'OpenCode client event feed reconnect deferred until next activity');
            });
          }
        });
        unsubscribeUpstream = async () => {
          subAbort.abort();
          await loop.catch(() => {});
        };
        created.broken = false;
      };

      const created: {
        refCount: number;
        readyPromise: Promise<void> | null;
        broken: boolean;
        closed: boolean;
        currentSubAbort: AbortController | null;
        ensureLive: () => Promise<void>;
        unsubscribe: () => Promise<void>;
      } = {
        refCount: 0,
        readyPromise: null,
        broken: true,
        closed: false,
        currentSubAbort: null,
        ensureLive: async () => {
          if (created.closed || this.activeClientEventSubs.get(client) !== created) return;
          if (!created.broken && created.readyPromise) {
            await created.readyPromise;
            return;
          }
          if (!created.broken && !created.readyPromise) {
            if (!subscribeEvents && created.currentSubAbort && !created.currentSubAbort.signal.aborted) {
              return;
            }
            if (subscribeEvents && subHostSubscribed && !ensureHostEvents) {
              return;
            }
          }
          if (created.readyPromise) {
            await created.readyPromise;
            if (!created.broken || created.closed || this.activeClientEventSubs.get(client) !== created) return;
          }
          const connecting = startFeed().catch((err) => {
            created.broken = true;
            throw err;
          }).finally(() => {
            if (created.readyPromise === connecting) {
              created.readyPromise = null;
            }
          });
          created.readyPromise = connecting;
          await connecting;
        },
        unsubscribe: async () => {
          const current = this.activeClientEventSubs.get(client);
          if (!current || current !== created) return;
          current.refCount = Math.max(0, current.refCount - 1);
          if (current.refCount > 0) return;
          created.closed = true;
          this.activeClientEventSubs.delete(client);
          created.currentSubAbort?.abort();
          await created.readyPromise?.catch(() => {});
          if (unsubscribeUpstream) {
            await unsubscribeUpstream().catch(() => {});
          }
        },
      };
      this.activeClientEventSubs.set(client, created);
      entry = created;
    }
    entry.refCount += 1;
    try {
      await entry.ensureLive();
    } catch (error) {
      entry.refCount = Math.max(0, entry.refCount - 1);
      if (entry.refCount === 0 && this.activeClientEventSubs.get(client) === entry) {
        entry.closed = true;
        this.activeClientEventSubs.delete(client);
      }
      throw error;
    }
    let released = false;
    const activeEntry = entry;
    return async () => {
      if (released) return;
      released = true;
      await activeEntry.unsubscribe();
    };
  }

  private async ensureClientEventSubscription(client: OpenCodeClientLike): Promise<void> {
    const entry = this.activeClientEventSubs.get(client);
    if (!entry) return;
    await entry.ensureLive();
  }

  private async startSessionRuntime(config: SessionConfig, cwd: string, _nativeAgentsFenced: boolean): Promise<{
    client: OpenCodeClientLike;
    server: OpenCodeServerLike;
    abort: AbortController;
    ensureEvents: () => Promise<void>;
    releaseEvents: () => Promise<void>;
    bindSessionMcp?: OpenCodeSdkRuntimeStartResult['bindSessionMcp'];
    unbindSessionMcp?: OpenCodeSdkRuntimeStartResult['unbindSessionMcp'];
  }> {
    const abort = new AbortController();
    const mcpServers = getDefaultMcpServers(config);
    let started: OpenCodeSdkRuntimeStartResult | null = null;
    const mcpServersConfig: Record<string, OpenCodeMcpServerSpec> = Object.fromEntries(
      Object.entries(mcpServers).map(([name, server]) => [name, {
        type: 'local',
        command: [server.command, ...server.args],
        environment: server.env,
        disabled: false,
      }]),
    );
    let releaseEvents: (() => Promise<void>) | null = null;
    try {
      started = await this.startConfiguredRuntime({
        hostname: LOOPBACK_HOST,
        port: 0,
        timeout: 10_000,
        signal: abort.signal,
        directory: cwd,
        warmupCatalog: true,
        hostGroupKey: this.hostGroupKey,
        mcpServers: mcpServersConfig,
        ...(this.databasePath ? { databasePath: this.databasePath } : {}),
        config: {
          share: 'disabled',
          mcp: { servers: mcpServersConfig },
        },
      });
      const url = new URL(started.server.url);
      if (!isLoopbackHostname(url.hostname)) {
        throw providerError(PROVIDER_ERROR_CODES.CONFIG_ERROR, 'OpenCode SDK session server did not bind to loopback', false);
      }
      const clientRef = started.client;
      releaseEvents = await this.acquireClientEventSubscription(clientRef, started.subscribeEvents, started.ensureEvents);
      return {
        client: clientRef,
        server: started.server,
        abort,
        ensureEvents: () => this.ensureClientEventSubscription(clientRef),
        releaseEvents,
        bindSessionMcp: started.bindSessionMcp,
        unbindSessionMcp: started.unbindSessionMcp,
      };
    } catch (error) {
      if (releaseEvents) await releaseEvents().catch(() => {});
      abort.abort();
      await Promise.resolve(started?.server.close()).catch(() => {});
      throw this.normalizeError(error, 'session server startup');
    }
  }

  private async closeStartedRuntime(runtime: {
    server: OpenCodeServerLike;
    abort: AbortController;
    releaseEvents: () => Promise<void>;
  }): Promise<void> {
    await runtime.releaseEvents().catch(() => {});
    runtime.abort.abort();
    await Promise.resolve(runtime.server.close()).catch(() => {});
  }

  private async closeSessionState(state: OpenCodeSessionState, unbindMcp = false, swallowCloseError = true): Promise<void> {
    this.clearPendingQuestion(state, true);
    for (const timer of state.pendingPermissions.values()) clearTimeout(timer);
    state.pendingPermissions.clear();
    state.surfacedQuestionCallIds.clear();
    if (unbindMcp && state.unbindSessionMcp) {
      await state.unbindSessionMcp(state.providerSessionId).catch(() => {});
    }
    await state.releaseEvents().catch(() => {});
    state.abort.abort();
    if (swallowCloseError) {
      await Promise.resolve(state.server.close()).catch(() => {});
    } else {
      await Promise.resolve(state.server.close());
    }
  }

  private releaseProviderRoute(state: OpenCodeSessionState): boolean {
    const ownsCurrentRoute = this.providerToRoute.get(state.providerSessionId) === state.routeId;
    const remainingRoutes = (this.providerRouteOrder.get(state.providerSessionId) ?? [])
      .filter((routeId) => (
        routeId !== state.routeId
        && this.sessions.get(routeId)?.providerSessionId === state.providerSessionId
      ));
    if (remainingRoutes.length > 0) this.providerRouteOrder.set(state.providerSessionId, remainingRoutes);
    else this.providerRouteOrder.delete(state.providerSessionId);
    if (!ownsCurrentRoute) return false;
    if (remainingRoutes.length > 0) {
      this.providerToRoute.set(state.providerSessionId, remainingRoutes[remainingRoutes.length - 1]!);
      return false;
    }
    this.providerToRoute.delete(state.providerSessionId);
    return true;
  }

  private registerProviderRoute(providerSessionId: string, routeId: string): void {
    const routes = (this.providerRouteOrder.get(providerSessionId) ?? [])
      .filter((candidate) => candidate !== routeId && this.sessions.has(candidate));
    routes.push(routeId);
    this.providerRouteOrder.set(providerSessionId, routes);
    this.providerToRoute.set(providerSessionId, routeId);
  }

  private handleEvent(event: Record<string, any>, sourceClient?: OpenCodeClientLike): void {
    const providerSessionId = sessionIdFromEvent(event);
    let targetState: OpenCodeSessionState | undefined;
    if (providerSessionId) {
      const routeId = this.providerToRoute.get(providerSessionId);
      const state = routeId ? this.sessions.get(routeId) : undefined;
      if (!state || !this.isRouteOwner(state)) return;
      if (sourceClient && state.client !== sourceClient) return;
      targetState = state;
    }

    const eventId = safeString(event.id ?? event.eventId);
    if (eventId) {
      if (this.seenEventIds.has(eventId)) return;
      this.seenEventIds.add(eventId);
      if (this.seenEventIds.size > 4096) {
        const oldest = this.seenEventIds.values().next().value;
        if (oldest !== undefined) this.seenEventIds.delete(oldest);
      }
    }
    if (event.type === 'model.updated' || event.type === 'provider.updated') {
      this.modelCache = null;
      return;
    }
    if (event.type === 'credential.switched' || event.type === 'credential.updated') {
      const credData = (event.data ?? event.properties) as Record<string, any> | undefined;
      if (safeString(credData?.integrationID) === 'opencode') {
        this.openCodeCredentialEpoch += 1;
        this.knownActiveOpenCodeCredFingerprint = undefined;
        this.openCodeCredentialProvenanceDirty = true;
        const changedCredId = safeString(credData?.credentialID);
        if (event.type === 'credential.switched') {
          this.knownActiveOpenCodeCredId = changedCredId ?? null;
          this.openCodeCredentialProvenanceLoaded = true;
        }
        for (const activeState of this.sessions.values()) {
          if (activeState.busy) {
            activeState.openCodeCredSwitchedDuringTurn = true;
            if (changedCredId) {
              activeState.openCodeCredChangedIdsDuringTurn.add(changedCredId);
            }
          }
        }
      }
      return;
    }
    if (!targetState) return;
    const state = targetState;
    const data = (event.data ?? event.properties) as Record<string, any> | undefined;
    const eventMessageId = safeString(data?.inputID ?? data?.userMessageID ?? data?.promptID);
    const eventAssistantId = safeString(data?.assistantMessageID);
    const inboxId = safeString(data?.inboxID);
    const isCompactionEvent = event.type === 'session.compaction.started'
      || event.type === 'session.compaction.ended'
      || event.type === 'session.compaction.failed';

    if (!isCompactionEvent) {
      if (eventMessageId && state.priorAttemptUserMessageIds.has(eventMessageId)) {
        return;
      }
      if (eventAssistantId && state.priorAttemptAssistantIds.has(eventAssistantId)) {
        return;
      }
      if (
        eventMessageId
        && state.deliveryMessageId
        && eventMessageId !== state.deliveryMessageId
      ) {
        return;
      }
    }

    const isCorrelatedRetryEvent = () => Boolean(
      (state.deliveryMessageId && eventMessageId === state.deliveryMessageId)
      || (eventAssistantId && !state.priorAttemptAssistantIds.has(eventAssistantId)),
    );
    const inRetryLifecycle = () => state.authHealPhase === 'retry-dispatched' || state.authHealPhase === 'retry-active';

    const markRetryLiveActivity = () => {
      state.retryActivitySeq += 1;
      state.retryReconcileToken += 1;
      state.retryTerminalReconcileInFlight = false;
      state.retryTerminalHint = null;
      state.retryTerminalError = undefined;
    };

    const ensureRetryReadyForContentEvent = (allowAckedGeneric = false): boolean => {
      if (state.authHealInFlight || state.authHealPhase === 'preparing') return false;
      if (state.authHealPhase === 'retry-dispatched') {
        if (isCorrelatedRetryEvent() || (!eventMessageId && !eventAssistantId && (allowAckedGeneric || event.type === 'session.step.started' || event.type === 'session.text.started' || event.type === 'session.text.delta'))) {
          state.authHealPhase = 'retry-active';
          markRetryLiveActivity();
          return true;
        }
        return false;
      }
      if (state.authHealPhase === 'retry-active') {
        markRetryLiveActivity();
      }
      return true;
    };

    switch (event.type) {
      case 'session.inbox.delivered': {
        if (
          state.busy
          && state.authHealPhase === 'retry-dispatched'
          && state.deliveryMessageId
          && (!inboxId || inboxId === state.deliveryMessageId)
        ) {
          state.authHealPhase = 'retry-active';
          state.authHealInFlight = false;
          markRetryLiveActivity();
        }
        return;
      }
      case 'session.step.started': {
        if (!state.busy || !ensureRetryReadyForContentEvent(true)) return;
        state.currentMessageId = safeString(data?.assistantMessageID) ?? state.currentMessageId;
        const providerID = safeString(data?.model?.providerID);
        if (providerID) state.activeStepProviderId = providerID;
        const modelID = safeString(data?.model?.id);
        if (providerID && modelID) {
          const model = `${providerID}/${modelID}`;
          if (state.model !== model) {
            state.model = model;
            this.emitSessionInfo(state);
          }
        }
        return;
      }
      case 'session.text.started': {
        if (!state.busy || !ensureRetryReadyForContentEvent(true)) return;
        state.currentMessageId = safeString(data?.assistantMessageID) ?? state.currentMessageId;
        const key = textPartKey(data?.assistantMessageID, data?.ordinal);
        if (!state.textParts.has(key)) state.textParts.set(key, '');
        return;
      }
      case 'session.text.delta': {
        if (!state.busy || !ensureRetryReadyForContentEvent(true)) return;
        state.currentMessageId = safeString(data?.assistantMessageID) ?? state.currentMessageId;
        const key = textPartKey(data?.assistantMessageID, data?.ordinal);
        const previous = state.textParts.get(key) ?? '';
        const chunk = typeof data?.delta === 'string' ? data.delta : '';
        if (!chunk) return;
        state.textParts.set(key, previous + chunk);
        this.emitTextDelta(state);
        return;
      }
      case 'session.text.ended': {
        if (!state.busy || !ensureRetryReadyForContentEvent(true)) return;
        state.currentMessageId = safeString(data?.assistantMessageID) ?? state.currentMessageId;
        const key = textPartKey(data?.assistantMessageID, data?.ordinal);
        if (typeof data?.text === 'string' && state.textParts.get(key) !== data.text) {
          state.textParts.set(key, data.text);
          this.emitTextDelta(state);
        }
        return;
      }
      case 'session.reasoning.started':
      case 'session.reasoning.delta': {
        if (!state.busy || !ensureRetryReadyForContentEvent(true)) return;
        this.emitStatus(state.routeId, { status: 'thinking', label: 'OpenCode is thinking…' });
        return;
      }
      case 'session.tool.input.started': {
        if (!state.busy || !ensureRetryReadyForContentEvent(true)) return;
        const id = safeString(data?.id);
        const name = safeString(data?.name);
        if (id && name) state.toolNames.set(id, name);
        return;
      }
      case 'session.tool.called': {
        if (!state.busy || !ensureRetryReadyForContentEvent(true)) return;
        const id = safeString(data?.id) ?? randomUUID();
        const name = state.toolNames.get(id) ?? safeString(data?.name) ?? safeString(data?.native?.tool) ?? 'tool';
        state.toolNames.set(id, name);
        if (data?.input !== undefined) state.toolInputs.set(id, data.input);
        this.emitToolCallEvent(state, { id, name, status: 'running', input: data?.input });
        return;
      }
      case 'session.tool.success': {
        if (!state.busy || !ensureRetryReadyForContentEvent(true)) return;
        const id = safeString(data?.id) ?? randomUUID();
        const name = state.toolNames.get(id) ?? safeString(data?.name) ?? safeString(data?.native?.tool) ?? 'tool';
        const output = extractToolContentText(data?.content);
        this.emitToolCallEvent(state, {
          id,
          name,
          status: 'complete',
          input: state.toolInputs.get(id),
          output,
        });
        return;
      }
      case 'session.tool.failed': {
        if (!state.busy || !ensureRetryReadyForContentEvent(true)) return;
        const id = safeString(data?.id) ?? randomUUID();
        const name = state.toolNames.get(id) ?? safeString(data?.name) ?? safeString(data?.native?.tool) ?? 'tool';
        const output = extractToolContentText(data?.content)
          ?? safeString(data?.error?.message)
          ?? (data?.error ? errorMessage(data.error) : undefined);
        this.emitToolCallEvent(state, {
          id,
          name,
          status: 'error',
          input: state.toolInputs.get(id),
          output,
        });
        return;
      }
      case 'session.usage.updated': {
        if (state.authHealInFlight || !ensureRetryReadyForContentEvent(true)) return;
        this.emitUsage(state, state.currentMessageId, data?.tokens, data?.cost, false);
        return;
      }
      case 'session.step.ended': {
        if (state.authHealInFlight || state.authHealPhase === 'preparing') return;
        if (isTerminalFinish(data?.finish) && inRetryLifecycle() && !isCorrelatedRetryEvent()) {
          this.scheduleRetryTerminalReconcile(state, state.generation, event.type);
          return;
        }
        if (!ensureRetryReadyForContentEvent(true)) return;
        state.currentMessageId = safeString(data?.assistantMessageID) ?? state.currentMessageId;
        this.emitUsage(state, data?.assistantMessageID, data?.tokens, data?.cost, true);
        if (isTerminalFinish(data?.finish)) {
          this.completeOnce(state, 'session.step.ended');
        }
        return;
      }
      case 'session.step.failed': {
        if (state.compacting || state.authHealInFlight || state.authHealPhase === 'preparing') return;
        if (inRetryLifecycle()) {
          if (isCorrelatedRetryEvent()) {
            state.authHealPhase = 'retry-active';
          } else {
            this.scheduleRetryTerminalReconcile(state, state.generation, event.type);
            return;
          }
        }
        state.currentMessageId = safeString(data?.assistantMessageID) ?? state.currentMessageId;
        this.emitUsage(state, data?.assistantMessageID, data?.tokens, data?.cost, true);
        this.handleSessionFailure(state, data?.error, 'step');
        return;
      }
      case 'session.execution.started': {
        if (
          state.authHealPhase === 'retry-dispatched'
          && state.deliveryMessageId
          && eventMessageId === state.deliveryMessageId
        ) {
          state.authHealPhase = 'retry-active';
          markRetryLiveActivity();
        } else if (state.authHealPhase === 'retry-active' && (!eventMessageId || eventMessageId === state.deliveryMessageId)) {
          markRetryLiveActivity();
        }
        if (state.busy && !state.compacting && !state.authHealInFlight && state.authHealPhase !== 'preparing') {
          this.emitStatus(state.routeId, { status: 'working', label: 'OpenCode is working…' });
        }
        return;
      }
      case 'session.execution.succeeded': {
        this.stopConfirmations.complete(state);
        // Late prompt completion frames must never settle an active manual /compact or auth-heal attempt.
        if (state.compacting || state.authHealInFlight || state.authHealPhase === 'preparing') return;
        if (inRetryLifecycle()) {
          if (isCorrelatedRetryEvent()) {
            state.authHealPhase = 'retry-active';
          } else {
            this.scheduleRetryTerminalReconcile(state, state.generation, event.type);
            return;
          }
        }
        this.completeOnce(state, 'session.execution.succeeded');
        return;
      }
      case 'session.execution.failed': {
        this.stopConfirmations.complete(state);
        if (state.compacting || state.authHealInFlight || state.authHealPhase === 'preparing') return;
        if (inRetryLifecycle()) {
          if (isCorrelatedRetryEvent()) {
            state.authHealPhase = 'retry-active';
          } else {
            this.scheduleRetryTerminalReconcile(state, state.generation, event.type, data?.error);
            return;
          }
        }
        this.handleSessionFailure(state, data?.error, 'session');
        return;
      }
      case 'session.execution.interrupted': {
        this.stopConfirmations.complete(state);
        if (state.compacting || state.authHealInFlight || state.authHealPhase === 'preparing') return;
        if (inRetryLifecycle() && !isCorrelatedRetryEvent()) {
          this.scheduleRetryTerminalReconcile(state, state.generation, event.type);
          return;
        }
        if (state.busy && !state.cancelled) {
          this.failOnce(state, providerError(
            PROVIDER_ERROR_CODES.CANCELLED,
            `OpenCode execution interrupted (${safeString(data?.reason) ?? 'user'})`,
            true,
          ));
        }
        return;
      }
      case 'session.retry.scheduled': {
        if (!state.busy || state.compacting || state.authHealInFlight || state.authHealPhase === 'preparing') return;
        if (state.authHealPhase === 'retry-dispatched' && isCorrelatedRetryEvent()) {
          state.authHealPhase = 'retry-active';
        }
        const msg = safeString(data?.error?.message) ?? `OpenCode is retrying (attempt ${data?.attempt ?? 1})…`;
        this.emitStatus(state.routeId, { status: 'retrying', label: msg });
        return;
      }
      case OPENCODE_PERMISSION_EVENT.ASKED:
      case OPENCODE_PERMISSION_EVENT.V2_ASKED:
      case OPENCODE_PERMISSION_EVENT.LEGACY_UPDATED:
        this.processPermission(state, normalizePermissionEvent(event.type, data));
        return;
      case 'form.created':
        this.processFormCreated(state, data?.form);
        return;
      case 'form.replied':
      case 'form.cancelled': {
        const requestId = safeString(data?.id);
        const pending = this.pendingQuestions.get(state.routeId);
        if (pending && (!requestId || pending.requestId === requestId)) {
          this.pendingQuestions.delete(state.routeId);
        }
        return;
      }
      case 'session.status': {
        const status = data?.status;
        if (state.compacting) {
          if (status?.type === 'idle') this.stopConfirmations.complete(state);
          return;
        }
        if (status?.type === 'idle') {
          this.stopConfirmations.complete(state);
          if (state.authHealInFlight || state.authHealPhase === 'preparing') return;
          if (inRetryLifecycle()) {
            if (isCorrelatedRetryEvent()) {
              state.authHealPhase = 'retry-active';
            } else {
              this.scheduleRetryTerminalReconcile(state, state.generation, event.type);
              return;
            }
          }
          this.completeOnce(state, 'session.status');
          return;
        }
        // Only surface progress while a turn is live; delayed/out-of-order busy/retry
        // frames after turn settlement must not strand the footer indicator.
        if (!state.busy || state.authHealInFlight || state.authHealPhase === 'preparing') return;
        if (status?.type === 'busy') this.emitStatus(state.routeId, { status: 'working', label: 'OpenCode is working…' });
        else if (status?.type === 'retry') this.emitStatus(state.routeId, { status: 'retrying', label: safeString(status.message) ?? 'OpenCode is retrying…' });
        return;
      }
      case 'session.compaction.started': {
        if (!state.compacting || !state.compactRequest || state.cancelled) return;
        state.compactRequest.sawV2Compaction = true;
        if (data?.reason !== 'manual') return;
        const startedInputId = safeString(data?.inputID);
        if (!startedInputId || startedInputId !== state.compactRequest.inputId) {
          return;
        }
        state.compactRequest.manualStarted = true;
        state.compactRequest.startedInputId = startedInputId;
        this.emitStatus(state.routeId, { status: 'compacting', label: 'Compacting conversation...' });
        return;
      }
      case 'session.compaction.ended': {
        this.stopConfirmations.complete(state);
        if (!state.compacting || !state.compactRequest || state.cancelled) return;
        state.compactRequest.sawV2Compaction = true;
        if (data?.reason !== 'manual') return;
        const endedInputId = safeString(data?.inputID);
        if (endedInputId) {
          if (endedInputId !== state.compactRequest.inputId) return;
        } else if (
          !state.compactRequest.manualStarted
          || state.compactRequest.startedInputId !== state.compactRequest.inputId
        ) {
          return;
        }
        this.completeCompactOnce(state, event.type);
        return;
      }
      case 'session.compacted':
        // Standalone legacy v1 compaction compatibility event (never overrides an active v2 compaction flow).
        this.stopConfirmations.complete(state);
        if (state.compacting && !state.cancelled && !state.compactRequest?.sawV2Compaction) {
          this.completeCompactOnce(state, event.type);
        }
        return;
      case 'session.compaction.failed': {
        this.stopConfirmations.complete(state);
        if (!state.compacting || !state.compactRequest || state.cancelled) return;
        state.compactRequest.sawV2Compaction = true;
        if (data?.reason !== 'manual') return;
        const failedInputId = safeString(data?.inputID);
        if (failedInputId && failedInputId !== state.compactRequest.inputId) {
          return;
        }
        if (!failedInputId && !state.compactRequest.manualStarted) {
          return;
        }
        this.failOnce(state, this.normalizeError(data?.error, 'compact'));
        return;
      }
      case 'session.idle':
        this.stopConfirmations.complete(state);
        if (state.compacting || state.authHealInFlight || state.authHealPhase === 'preparing') return;
        if (inRetryLifecycle()) {
          if (isCorrelatedRetryEvent()) {
            state.authHealPhase = 'retry-active';
          } else {
            this.scheduleRetryTerminalReconcile(state, state.generation, event.type);
            return;
          }
        }
        this.completeOnce(state, 'session.idle');
        return;
      default:
        return;
    }
  }

  private processAssistantMessageRecord(state: OpenCodeSessionState, msg: Record<string, any> | undefined): boolean {
    if (!msg || msg.type !== 'assistant') return false;
    state.currentMessageId = safeString(msg.id) ?? state.currentMessageId;
    if (safeString(msg.model?.providerID) && safeString(msg.model?.id)) {
      const model = `${msg.model.providerID}/${msg.model.id}`;
      if (state.model !== model) {
        state.model = model;
        this.emitSessionInfo(state);
      }
    }
    this.emitUsage(state, msg.id, msg.tokens, msg.cost, true);
    if (Array.isArray(msg.content)) {
      let ordinal = 0;
      for (const item of msg.content) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text' && typeof item.text === 'string') {
          const key = textPartKey(msg.id, ordinal++);
          if (state.textParts.get(key) !== item.text) {
            state.textParts.set(key, item.text);
            this.emitTextDelta(state);
          }
        } else if (item.type === 'tool') {
          const id = safeString(item.id) ?? randomUUID();
          const name = safeString(item.name) ?? 'tool';
          const toolState = item.state ?? {};
          const status: ToolCallEvent['status'] = toolState.status === 'completed'
            ? 'complete'
            : toolState.status === 'error'
              ? 'error'
              : 'running';
          const output = status === 'error'
            ? (extractToolContentText(toolState.content) ?? safeString(toolState.error?.message))
            : extractToolContentText(toolState.content);
          this.emitToolCallEvent(state, { id, name, status, input: toolState.input, output });
        }
      }
    }
    if (msg.error) {
      this.failOnce(state, this.normalizeError(msg.error, 'message'));
    }
    return isTerminalAssistantMessage(msg);
  }

  private emitTextDelta(state: OpenCodeSessionState): void {
    const content = [...state.textParts.values()].join('');
    if (!content) return;
    const messageId = state.currentMessageId ?? `${state.providerSessionId}:assistant`;
    const update: MessageDelta = { messageId, type: 'text', delta: content, role: 'assistant' };
    for (const callback of this.deltaCallbacks) callback(state.routeId, update);
  }

  private emitToolCallEvent(
    state: OpenCodeSessionState,
    params: { id: string; name: string; status: ToolCallEvent['status']; input?: unknown; output?: string },
  ): void {
    if ((params.name === 'question' || params.name === 'form') && (params.status === 'running' || state.surfacedQuestionCallIds.has(params.id))) {
      return;
    }
    const signature = JSON.stringify([params.status, params.input, params.output]);
    if (state.toolSignatures.get(params.id) === signature) return;
    state.toolSignatures.set(params.id, signature);
    const event: ToolCallEvent = {
      id: params.id,
      name: params.name,
      status: params.status,
      ...(params.input !== undefined ? { input: params.input } : {}),
      ...(params.output !== undefined ? { output: params.output } : {}),
      detail: {
        kind: 'opencode.tool',
        summary: params.name,
        input: params.input,
        output: params.output,
        meta: { provider: this.id, providerSessionId: state.providerSessionId },
      },
    };
    for (const callback of this.toolCallbacks) callback(state.routeId, event);
    if (
      params.status === 'complete'
      && state.cronControlActive
      && isCronSilentResult(params.output)
    ) {
      state.silentToolResult = CRON_CONTROL_PROTOCOL.SILENT_RESULT;
      this.finishOnce(state, CRON_CONTROL_PROTOCOL.SILENT_RESULT, 'cron.tool.silent');
    }
  }

  private processFormCreated(state: OpenCodeSessionState, form: Record<string, any> | undefined): void {
    const normalized = normalizeFormToQuestions(form);
    if (!normalized) return;
    const { requestId, questions, fields } = normalized;
    const callId = safeString(form?.metadata?.callID);
    if (callId) state.surfacedQuestionCallIds.add(callId);
    const previous = this.pendingQuestions.get(state.routeId);
    if (previous && previous.requestId !== requestId && state.client.session?.form?.cancel) {
      void state.client.session.form.cancel({
        sessionID: state.providerSessionId,
        formID: previous.requestId,
      }).catch(() => {});
    }
    this.pendingQuestions.set(state.routeId, { requestId, questions, fields, ...(callId ? { callId } : {}) });
    const event: ToolCallEvent = {
      id: callId ?? requestId,
      name: INTERACTIVE_QUESTION_TOOL_NAME,
      status: 'complete',
      input: { questions },
    };
    for (const callback of this.toolCallbacks) callback(state.routeId, event);
  }

  private clearPendingQuestion(state: OpenCodeSessionState, cancelPending: boolean): void {
    const pending = this.pendingQuestions.get(state.routeId);
    if (!pending) return;
    this.pendingQuestions.delete(state.routeId);
    if (cancelPending && state.client.session?.form?.cancel) {
      void state.client.session.form.cancel({
        sessionID: state.providerSessionId,
        formID: pending.requestId,
      }).catch(() => {});
    }
  }

  private processPermission(state: OpenCodeSessionState, permission: NormalizedOpenCodePermission | undefined): void {
    if (!permission) return;
    if (this.toolExecutionGuard) {
      const guard = this.toolExecutionGuard;
      const { id, operation, callId, rawInput, pattern } = permission;
      const effectiveToolUseId = callId ?? id;
      void Promise.resolve().then(() => guard(state.routeId, {
        toolName: operation ?? 'permission',
        input: rawInput ?? pattern,
        cwd: state.cwd,
        ...(effectiveToolUseId ? { toolUseId: effectiveToolUseId } : {}),
      })).then((decision) => {
        if (!decision.allow) {
          void this.replyPermission(state, id, false).catch((error) => {
            this.emitError(state.routeId, this.normalizeError(error, 'permission rejection'));
          });
          return;
        }
        this.forwardPermissionApproval(state, permission);
      }).catch(() => {
        let isParticipantTurn = false;
        try {
          isParticipantTurn = this.participantTurnResolver?.(state.routeId) === true;
        } catch {
          // Fail-closed when participant turn resolver itself throws.
          isParticipantTurn = true;
        }
        if (isParticipantTurn) {
          void this.replyPermission(state, id, false).catch((error) => {
            this.emitError(state.routeId, this.normalizeError(error, 'permission rejection'));
          });
          return;
        }
        this.forwardPermissionApproval(state, permission);
      });
      return;
    }
    this.forwardPermissionApproval(state, permission);
  }

  private forwardPermissionApproval(state: OpenCodeSessionState, permission: NormalizedOpenCodePermission): void {
    const { id, operation, title, pattern, callId } = permission;
    const effectiveToolUseId = callId ?? id;
    const request: ApprovalRequest = {
      id,
      description: title ?? `Allow OpenCode ${operation ?? 'operation'}${pattern ? `: ${pattern}` : ''}`,
      ...(operation ? { tool: operation } : {}),
      provider: this.id,
      providerGeneration: state.generation,
      ...(effectiveToolUseId ? { providerToolUseId: effectiveToolUseId } : {}),
      ...(pattern ? { inputPreview: pattern.slice(0, 300) } : {}),
    };
    if (this.approvalCallbacks.length === 0) {
      void this.replyPermission(state, id, false).catch((error) => {
        this.emitError(state.routeId, this.normalizeError(error, 'permission rejection'));
      });
      return;
    }
    if (state.pendingPermissions.has(id)) return;
    const timer = setTimeout(() => {
      if (!state.pendingPermissions.delete(id)) return;
      void this.replyPermission(state, id, false).catch((error) => {
        this.emitError(state.routeId, this.normalizeError(error, 'permission timeout'));
      });
    }, this.approvalTimeoutMs);
    timer.unref?.();
    state.pendingPermissions.set(id, timer);
    for (const callback of this.approvalCallbacks) callback(state.routeId, request);
  }

  private emitUsage(state: OpenCodeSessionState, messageId: unknown, tokens: any, cost: unknown, finalized: boolean): void {
    if (!tokens || typeof tokens !== 'object') return;
    const modelContextWindow = state.model ? this.modelContextWindows.get(state.model) : undefined;
    if (state.model && modelContextWindow === undefined) this.scheduleContextWindowRefresh(state.model);
    const inputTokens = positiveNumber(tokens.input) ?? 0;
    const outputTokens = positiveNumber(tokens.output) ?? 0;
    const cacheReadTokens = positiveNumber(tokens.cache?.read) ?? 0;
    const cacheWriteTokens = positiveNumber(tokens.cache?.write) ?? 0;
    const normalizedMessageId = safeString(messageId);

    // OpenCode emits zero-token snapshots before the step finishes. Expose the
    // authoritative context limit without publishing a finalized 0-usage frame.
    if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) {
      if (state.lastUsage || modelContextWindow === undefined) return;
      const metadataOnlyUsage = { model_context_window: modelContextWindow };
      const metadataOnlySignature = JSON.stringify(metadataOnlyUsage);
      if (metadataOnlySignature === state.lastUsageSignature) return;
      state.lastUsageSignature = metadataOnlySignature;
      const update: ProviderUsageUpdate = {
        ...(normalizedMessageId ? { messageId: normalizedMessageId } : {}),
        finalized: false,
        usage: metadataOnlyUsage,
        ...(state.model ? { model: state.model } : {}),
      };
      for (const callback of this.usageCallbacks) callback(state.routeId, update);
      return;
    }

    const usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheWriteTokens,
      ...(modelContextWindow !== undefined ? { model_context_window: modelContextWindow } : {}),
      ...(positiveNumber(cost) !== undefined ? { cost_usd: cost } : {}),
    };
    state.lastUsage = usage;
    state.lastUsageMessageId = normalizedMessageId ?? state.lastUsageMessageId;
    const signature = JSON.stringify(usage);
    if (signature === state.lastUsageSignature) return;
    state.lastUsageSignature = signature;
    const update: ProviderUsageUpdate = {
      ...(normalizedMessageId ? { messageId: normalizedMessageId } : {}),
      finalized,
      usage,
      ...(state.model ? { model: state.model } : {}),
    };
    for (const callback of this.usageCallbacks) callback(state.routeId, update);
  }

  private completeOnce(state: OpenCodeSessionState, source: string): void {
    if (!state.busy || state.completionEmitted || state.terminalErrorEmitted || state.cancelled) return;
    const content = [...state.textParts.values()].join('');
    if (!content.trim()) {
      if (state.cronControlActive && state.silentToolResult) {
        this.finishOnce(state, state.silentToolResult, 'cron.tool.silent');
        return;
      }
      // Wait for step/execution completion if `session.step.ended` arrived without text.
      if (source === 'session.step.ended' || state.missingFinalRecoveryInFlight) return;
      if (!state.missingFinalRecoveryAttempted) {
        this.recoverMissingFinalOnce(state);
        return;
      }
      this.failOnce(state, providerError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        'OpenCode ended the turn without a final response.',
        false,
        { source },
      ));
      return;
    }
    this.finishOnce(state, content, source);
  }

  private finishOnce(state: OpenCodeSessionState, content: string, source: string): void {
    if (!state.busy || state.completionEmitted || state.terminalErrorEmitted || state.cancelled) return;
    state.completionEmitted = true;
    state.busy = false;
    state.authHealInFlight = false;
    state.activeTurnParams = null;
    this.emitStatus(state.routeId, { status: null, label: null });
    const message: AgentMessage = {
      id: state.currentMessageId ?? state.lastUsageMessageId ?? `${state.providerSessionId}:${state.generation}`,
      sessionId: state.routeId,
      kind: 'text',
      role: 'assistant',
      content,
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        provider: this.id,
        providerSessionId: state.providerSessionId,
        source,
        ...(state.model ? { model: state.model } : {}),
        ...(state.lastUsage ? { usage: state.lastUsage } : {}),
      },
    };
    for (const callback of this.completeCallbacks) callback(state.routeId, message);
  }

  private recoverMissingFinalOnce(state: OpenCodeSessionState): void {
    if (
      !state.busy
      || state.cancelled
      || state.missingFinalRecoveryAttempted
      || state.missingFinalRecoveryInFlight
    ) return;
    state.missingFinalRecoveryAttempted = true;
    state.missingFinalRecoveryInFlight = true;
    const generation = state.generation;
    void this.runMissingFinalRecovery(state, generation);
  }

  private async runMissingFinalRecovery(state: OpenCodeSessionState, generation: number): Promise<void> {
    const deliveryMessageId = state.deliveryMessageId
      ?? openCodePromptMessageId(state.providerSessionId, `${state.routeId}:${generation}`);
    const recoveryMessageId = openCodeRecoveryMessageId(state.providerSessionId, deliveryMessageId);
    let lastError: unknown;

    for (const delayMs of MISSING_FINAL_RECOVERY_RECHECK_DELAYS_MS) {
      if (delayMs > 0) await sleep(delayMs);
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      try {
        const recovered = await this.tryMissingFinalRecovery(state, recoveryMessageId);
        if (!this.isCurrent(state, generation) || state.cancelled) return;
        if (recovered) {
          state.missingFinalRecoveryInFlight = false;
          this.completeOnce(state, 'recovery.prompt.result');
          return;
        }
        lastError = undefined;
      } catch (error) {
        lastError = error;
        if (!isTransientRequestFailure(error) && !(error instanceof OpenCodeRequestTimeoutError)) break;
      }
    }

    if (!this.isCurrent(state, generation) || state.cancelled) return;
    if (lastError) {
      try {
        const restarted = await this.restartSessionRuntime(state, generation);
        if (!restarted) return;
        const recovered = await this.tryMissingFinalRecovery(state, recoveryMessageId);
        if (!this.isCurrent(state, generation) || state.cancelled) return;
        if (recovered) {
          state.missingFinalRecoveryInFlight = false;
          this.completeOnce(state, 'recovery.prompt.result.after-reconnect');
          return;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (!this.isCurrent(state, generation) || state.cancelled) return;
    state.missingFinalRecoveryInFlight = false;
    const normalized = lastError
      ? this.normalizeError(lastError, 'missing final response recovery')
      : providerError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        'OpenCode ended the turn without a final response after bounded recovery.',
        false,
        { recoveryMessageId },
      );
    this.failOnce(state, normalized);
  }

  private async tryMissingFinalRecovery(
    state: OpenCodeSessionState,
    recoveryMessageId: string,
  ): Promise<boolean> {
    await withOpenCodeRequestTimeout(
      state.client.sessions.get({ sessionID: state.providerSessionId }),
      'session health check',
    );

    const accepted = await withOpenCodeRequestTimeout(
      this.hasAcceptedPrompt(state, recoveryMessageId),
      'missing final acceptance check',
    );
    if (accepted) return this.loadAcceptedRecoveryResult(state, recoveryMessageId);

    await this.syncSessionModelAndEffort(state);
    await withOpenCodeRequestTimeout(
      state.client.sessions.prompt({
        sessionID: state.providerSessionId,
        id: recoveryMessageId,
        text: MISSING_FINAL_RECOVERY_PROMPT,
      }),
      'missing final recovery prompt',
    );
    if (state.client.experimental?.session?.wait) {
      await withOpenCodeRequestTimeout(
        state.client.experimental.session.wait({ sessionID: state.providerSessionId }),
        'missing final recovery wait',
      );
    }
    return this.loadAcceptedRecoveryResult(state, recoveryMessageId);
  }

  private async loadAcceptedRecoveryResult(
    state: OpenCodeSessionState,
    recoveryMessageId: string,
  ): Promise<boolean> {
    if (state.completionEmitted) return true;
    const res = await withOpenCodeRequestTimeout(
      state.client.message.list({ sessionID: state.providerSessionId, limit: 100, order: 'desc' }),
      'missing final recovery reconciliation',
    );
    const items = Array.isArray(res?.data) ? (res.data as Array<Record<string, any>>) : [];
    const recoveryUserIdx = items.findIndex((item) => item?.id === recoveryMessageId && item?.type === 'user');
    const searchPool = recoveryUserIdx >= 0 ? items.slice(0, recoveryUserIdx) : items;
    const recovered = searchPool.find((item) => isTerminalAssistantMessage(item));
    if (!recovered) return false;
    return this.processAssistantMessageRecord(state, recovered)
      && Boolean([...state.textParts.values()].join('').trim());
  }

  private async restartSessionRuntime(state: OpenCodeSessionState, generation: number): Promise<boolean> {
    // A replacement runtime preserves any active fence for this session.
    const nativeAgentsFenced = state.nativeAgentFence === NATIVE_AGENT_FENCES.DISABLED
      || this.nativeAgentFence.required(state.routeId, state.runtimeConfig.sessionName);
    const replacement = await this.startSessionRuntime(state.runtimeConfig, state.cwd, nativeAgentsFenced);
    let verifiedInfo: OpenCodeSessionInfoLike;
    try {
      verifiedInfo = await withOpenCodeRequestTimeout(
        this.ensureSessionPresentOrImportLegacy(replacement.client, state.providerSessionId, state.cwd),
        'session reconnect verification',
      );
      if ((nativeAgentsFenced || this.toolExecutionGuard) && typeof replacement.client.session?.update === 'function') {
        await replacement.client.session.update({
          sessionID: verifiedInfo.id,
          permissions: mergeOpenCodeFencedPermissions(
            verifiedInfo.permissions,
            nativeAgentsFenced,
            Boolean(this.toolExecutionGuard),
          ),
        });
      }
    } catch (error) {
      await this.closeStartedRuntime(replacement);
      throw error;
    }

    if (!this.isCurrent(state, generation) || state.cancelled) {
      await this.closeStartedRuntime(replacement);
      return false;
    }

    const previous = {
      abort: state.abort,
      server: state.server,
      releaseEvents: state.releaseEvents,
    };
    state.client = replacement.client;
    state.server = replacement.server;
    state.abort = replacement.abort;
    state.ensureEvents = replacement.ensureEvents;
    state.releaseEvents = replacement.releaseEvents;
    state.bindSessionMcp = replacement.bindSessionMcp;
    state.unbindSessionMcp = replacement.unbindSessionMcp;
    state.syncedMcpSignature = null;
    state.nativeAgentFence = fenceOf(nativeAgentsFenced);
    await this.withProviderSessionLock(state.providerSessionId, async () => {
      if (!this.isRouteOwner(state)) return;
      await this.syncSessionMcp(state).catch(() => {});
    });
    await previous.releaseEvents().catch(() => {});
    previous.abort.abort();
    await Promise.resolve(previous.server.close()).catch(() => {});
    logger.warn(
      { provider: this.id, sessionId: state.routeId, providerSessionId: state.providerSessionId },
      'OpenCode session runtime reconnected during missing-final recovery',
    );
    return true;
  }

  private async refreshOpenCodeCredentialProvenance(client: OpenCodeClientLike): Promise<void> {
    const credentialApi = client.credential ?? this.client?.credential;
    if (!credentialApi?.list) {
      this.knownActiveOpenCodeCredId = undefined;
      this.knownActiveOpenCodeCredFingerprint = undefined;
      this.openCodeCredentialProvenanceLoaded = true;
      this.openCodeCredentialProvenanceDirty = false;
      return;
    }
    const epochBefore = this.openCodeCredentialEpoch;
    try {
      const creds = await withOpenCodeRequestTimeout(credentialApi.list(), 'credential provenance lookup');
      if (this.openCodeCredentialEpoch !== epochBefore) {
        // An SSE credential change raced with the lookup; keep dirty so the next turn re-syncs cleanly.
        this.openCodeCredentialProvenanceDirty = true;
        return;
      }
      const opencodeCreds = creds.filter((cred) => cred?.integrationID === 'opencode' && safeString(cred.id));
      const activeCreds = opencodeCreds.filter((cred) => cred.active === true);
      if (activeCreds.length === 1) {
        const chosen = activeCreds[0] as Record<string, any>;
        this.knownActiveOpenCodeCredId = safeString(chosen.id)!;
        this.knownActiveOpenCodeCredFingerprint = fingerprintCredentialValue(chosen);
      } else if (activeCreds.length === 0 && opencodeCreds.length === 1 && opencodeCreds[0]?.active !== false) {
        const chosen = opencodeCreds[0] as Record<string, any>;
        this.knownActiveOpenCodeCredId = safeString(chosen.id)!;
        this.knownActiveOpenCodeCredFingerprint = fingerprintCredentialValue(chosen);
      } else if (opencodeCreds.length === 0) {
        this.knownActiveOpenCodeCredId = null;
        this.knownActiveOpenCodeCredFingerprint = undefined;
      } else {
        this.knownActiveOpenCodeCredId = undefined;
        this.knownActiveOpenCodeCredFingerprint = undefined;
      }
      this.openCodeCredentialProvenanceLoaded = true;
      this.openCodeCredentialProvenanceDirty = false;
    } catch {
      this.knownActiveOpenCodeCredId = undefined;
      this.knownActiveOpenCodeCredFingerprint = undefined;
      this.openCodeCredentialProvenanceDirty = true;
    }
  }

  private scheduleRetryTerminalReconcile(
    state: OpenCodeSessionState,
    generation: number,
    eventType: string,
    terminalError?: unknown,
  ): void {
    const isTerminalFailOrInterrupt = eventType === 'session.execution.failed'
      || eventType === 'session.execution.interrupted';
    const currentIsFailOrInterrupt = state.retryTerminalHint === 'session.execution.failed'
      || state.retryTerminalHint === 'session.execution.interrupted';
    if (isTerminalFailOrInterrupt || !currentIsFailOrInterrupt) {
      state.retryTerminalHint = eventType;
      if (terminalError !== undefined) state.retryTerminalError = terminalError;
    }
    if (state.retryTerminalReconcileInFlight) return;
    state.retryTerminalReconcileInFlight = true;
    const reconcileToken = ++state.retryReconcileToken;
    void this.reconcileRetryTerminalFrame(state, generation, reconcileToken);
  }

  private async reconcileRetryTerminalFrame(
    state: OpenCodeSessionState,
    generation: number,
    reconcileToken: number,
  ): Promise<void> {
    const canContinue = () => (
      this.isCurrent(state, generation)
      && state.retryReconcileToken === reconcileToken
      && !state.cancelled
      && this.isRouteOwner(state)
      && !state.completionEmitted
      && !state.terminalErrorEmitted
      && (state.authHealPhase === 'retry-dispatched' || state.authHealPhase === 'retry-active')
    );
    const retryMessageId = state.deliveryMessageId;
    const activitySeqAtStart = state.retryActivitySeq;
    let lastReadError: unknown = null;
    let cleanNonTerminalChecks = 0;

    try {
      for (const delayMs of RETRY_TERMINAL_RECONCILE_DELAYS_MS) {
        if (delayMs > 0) await sleep(delayMs);
        if (!canContinue()) return;
        if (state.retryActivitySeq !== activitySeqAtStart) return;

        let items: Array<Record<string, any>>;
        try {
          const res = await withOpenCodeRequestTimeout(
            state.client.message.list({ sessionID: state.providerSessionId, limit: 20, order: 'desc' }),
            'auth-heal retry terminal reconciliation',
          );
          if (!canContinue()) return;
          if (!Array.isArray(res?.data)) {
            throw new Error('OpenCode history response missing data array');
          }
          items = res.data as Array<Record<string, any>>;
          lastReadError = null;
        } catch (error) {
          lastReadError = error;
          continue;
        }

        const retryUserIdx = retryMessageId
          ? items.findIndex((item) => item?.id === retryMessageId && item?.type === 'user')
          : -1;
        const candidatePool = retryUserIdx >= 0 ? items.slice(0, retryUserIdx) : items;
        const terminalAssistant = candidatePool.find((item) => {
          if (!isTerminalAssistantMessage(item)) return false;
          const assistantId = safeString(item.id);
          const parentId = safeString(item.parentID);
          if (assistantId && state.priorAttemptAssistantIds.has(assistantId)) return false;
          if (parentId && state.priorAttemptUserMessageIds.has(parentId)) return false;
          if (retryMessageId && parentId && parentId !== retryMessageId) return false;
          return retryUserIdx >= 0 || (retryMessageId !== null && parentId === retryMessageId);
        });

        if (terminalAssistant) {
          const hint = state.retryTerminalHint ?? 'session.execution.succeeded';
          state.authHealPhase = 'retry-active';
          state.authHealInFlight = false;
          if (terminalAssistant.error) {
            this.handleSessionFailure(
              state,
              terminalAssistant.error,
              hint === 'session.step.failed' ? 'step' : 'session',
            );
            return;
          }
          this.processAssistantMessageRecord(state, terminalAssistant);
          this.completeOnce(state, hint);
          return;
        }

        if (!canContinue() || state.retryActivitySeq !== activitySeqAtStart) return;

        if (retryMessageId && typeof state.client.session.inbox?.list === 'function') {
          try {
            const inboxRaw = await withOpenCodeRequestTimeout(
              state.client.session.inbox.list({ sessionID: state.providerSessionId }),
              'auth-heal retry inbox check',
            );
            if (!canContinue()) return;
            const inboxItems = Array.isArray(inboxRaw)
              ? inboxRaw
              : (Array.isArray(inboxRaw?.data) ? inboxRaw.data : []);
            if (inboxItems.some((item) => item?.id === retryMessageId)) {
              // Retry prompt is still pending in the SDK inbox; the hint came from an earlier attempt.
              return;
            }
          } catch {
            // Fall through to bounded history reconciliation when inbox check fails transiently.
          }
        }

        cleanNonTerminalChecks += 1;
        const isTerminalFailOrInterrupt = state.retryTerminalHint === 'session.execution.failed'
          || state.retryTerminalHint === 'session.execution.interrupted';
        if (!isTerminalFailOrInterrupt && cleanNonTerminalChecks >= 2) {
          return;
        }
      }

      if (!canContinue() || state.retryActivitySeq !== activitySeqAtStart) return;
      if (lastReadError !== null) {
        this.failOnce(
          state,
          providerError(
            PROVIDER_ERROR_CODES.CONNECTION_LOST,
            `OpenCode retry completion could not be confirmed due to repeated history read failures: ${errorMessage(lastReadError)}`,
            true,
          ),
        );
        return;
      }
      if (state.retryTerminalHint === 'session.execution.failed' || state.retryTerminalHint === 'session.execution.interrupted') {
        if (typeof state.client.session.active === 'function') {
          let activeMap: Record<string, unknown> | null = null;
          try {
            const rawActive = await withOpenCodeRequestTimeout(
              state.client.session.active(),
              'auth-heal retry active check',
            );
            if (!canContinue() || state.retryActivitySeq !== activitySeqAtStart) return;
            activeMap = rawActive && typeof rawActive === 'object' && 'data' in rawActive && rawActive.data && typeof rawActive.data === 'object'
              ? (rawActive.data as Record<string, unknown>)
              : (rawActive && typeof rawActive === 'object' ? rawActive : null);
          } catch {
            // Active status check failed -> execution status unknown -> preserve active retry turn.
            return;
          }
          if (!activeMap || Object.prototype.hasOwnProperty.call(activeMap, state.providerSessionId)) {
            // Session is still running (quiet pre-first-byte/tool phase) or status unknown -> do not fail Retry.
            return;
          }
        }
        if (state.retryTerminalHint === 'session.execution.failed') {
          const normalized = state.retryTerminalError
            ? this.normalizeError(state.retryTerminalError, 'session')
            : providerError(
              PROVIDER_ERROR_CODES.PROVIDER_ERROR,
              'OpenCode retry execution failed before generating an assistant response',
              true,
            );
          this.failOnce(state, normalized.recoverable ? normalized : { ...normalized, recoverable: true });
          return;
        }
        this.failOnce(
          state,
          providerError(
            PROVIDER_ERROR_CODES.CANCELLED,
            'OpenCode retry execution was interrupted before generating an assistant response',
            true,
          ),
        );
      }
    } finally {
      if (this.isCurrent(state, generation) && state.retryReconcileToken === reconcileToken) {
        state.retryTerminalReconcileInFlight = false;
      }
    }
  }

  private handleSessionFailure(state: OpenCodeSessionState, rawError: unknown, operation: string): void {
    if (!state.busy || state.completionEmitted || state.terminalErrorEmitted || state.cancelled) return;
    if (state.authHealInFlight || state.authHealPhase === 'preparing') return;
    const sessionProviderId = state.activeStepProviderId
      ?? parseModelIdentity(state.model)?.providerID
      ?? parseModelIdentity(this.modelCache?.value.defaultModel)?.providerID;
    const turnParams = state.activeTurnParams;
    if (
      turnParams
      && turnParams.generation === state.generation
      && isExpiredOpenCodeAuthError(rawError, sessionProviderId)
    ) {
      if (!turnParams.authHealAttempted) {
        state.authHealInFlight = true;
        state.authHealPhase = 'preparing';
        state.authHealRetryAcked = false;
        state.retryTerminalReconcileInFlight = false;
        state.retryTerminalHint = null;
        state.priorAttemptUserMessageIds.add(turnParams.messageId);
        if (state.currentMessageId) state.priorAttemptAssistantIds.add(state.currentMessageId);
        turnParams.authHealAttempted = true;
        const healGeneration = ++state.generation;
        turnParams.generation = healGeneration;
        void this.tryHealExpiredOpenCodeAuthAndRetry(state, healGeneration, rawError);
        return;
      }
      this.failOnce(
        state,
        providerError(
          PROVIDER_ERROR_CODES.AUTH_FAILED,
          `OpenCode API key is expired or invalid and automatic credential cleanup did not recover it (${errorMessage(rawError)}). Check whether OPENCODE_API_KEY in the environment is expired or re-authenticate OpenCode.`,
          false,
        ),
      );
      return;
    }
    this.failOnce(state, this.normalizeError(rawError, operation));
  }

  private async tryHealExpiredOpenCodeAuthAndRetry(
    state: OpenCodeSessionState,
    healGeneration: number,
    rawError: unknown,
  ): Promise<void> {
    const params = state.activeTurnParams;
    const aborted = () => !this.isCurrent(state, healGeneration) || state.cancelled || !this.isRouteOwner(state);
    if (!params || aborted()) {
      state.authHealInFlight = false;
      state.authHealPhase = 'none';
      return;
    }
    try {
      this.emitStatus(state.routeId, {
        status: 'retrying',
        label: 'Expired OpenCode key detected; clearing credential and retrying…',
      });
      const explicitCredId = errorExplicitCredentialId(rawError);
      if (safeString(process.env.OPENCODE_API_KEY) && !explicitCredId) {
        throw new Error(
          'OPENCODE_API_KEY is active in the environment and cannot be attributed to a removable stored opencode credential; stored credentials were preserved',
        );
      }
      const credentialApi = state.client.credential ?? this.client?.credential;
      let clearedStoredCred = false;
      let preservedNewerCred = state.openCodeCredSwitchedDuringTurn
        || this.openCodeCredentialEpoch !== params.credEpochAtDispatch;
      const targetCredId = explicitCredId
        ?? (typeof params.expectedCredIdAtDispatch === 'string' ? params.expectedCredIdAtDispatch : undefined);

      if (credentialApi?.list && credentialApi?.remove) {
        const creds = await credentialApi.list();
        if (aborted()) return;
        const opencodeCreds = creds.filter((cred) => cred?.integrationID === 'opencode' && safeString(cred.id));
        const epochChanged = this.openCodeCredentialEpoch !== params.credEpochAtDispatch
          || state.openCodeCredSwitchedDuringTurn;
        if (epochChanged) preservedNewerCred = true;

        // If another stored opencode credential is already active in list() (even before SSE switched arrives),
        // treat the active selection as replaced only when we knew the pre-turn baseline (`targetCredId` or clean empty store).
        const anotherActiveCredExists = targetCredId
          ? opencodeCreds.some((cred) => cred.id !== targetCredId && cred.active === true)
          : (params.expectedCredIdAtDispatch === null && opencodeCreds.some((cred) => cred.active === true));
        if (anotherActiveCredExists) {
          preservedNewerCred = true;
        }

        if (!targetCredId) {
          if (!preservedNewerCred && opencodeCreds.length > 0) {
            throw new Error(
              'Expired OpenCode credential provenance could not be verified for this turn; stored credentials were preserved',
            );
          }
        } else if (state.openCodeCredChangedIdsDuringTurn.has(targetCredId)) {
          // Same-ID credential was updated/switched during this turn and the SDK lacks conditional remove: preserve it.
          preservedNewerCred = true;
        } else {
          const matched = opencodeCreds.find((cred) => cred.id === targetCredId) as Record<string, any> | undefined;
          if (!matched) {
            preservedNewerCred = true;
          } else {
            const matchedValue = matched.value && typeof matched.value === 'object'
              ? (matched.value as Record<string, unknown>)
              : undefined;
            const matchedCredType = safeString(matchedValue?.type)?.toLowerCase();
            const isNonAtomicMutableCred = Boolean(
              matchedCredType === 'oauth'
              || matchedCredType === 'external'
              || safeString(matchedValue?.refresh)
              || safeString(matchedValue?.access)
              || safeString(matchedValue?.methodID)
              || (matchedValue !== undefined && matchedCredType !== 'key' && matchedCredType !== 'api'),
            );
            if (isNonAtomicMutableCred) {
              throw new Error(
                `OpenCode ${matchedCredType ?? 'oauth'} credential "${matched.id}" cannot be safely auto-deleted because the SDK lacks an atomic version/fingerprint precondition; reconnect OpenCode authentication or switch providers`,
              );
            }
            const currentFingerprint = fingerprintCredentialValue(matched);
            const rawTs = positiveNumber(matched.time?.updated ?? matched.time?.created ?? matched.updatedAt ?? matched.createdAt);
            const credTs = rawTs !== undefined && rawTs < 1e12 ? rawTs * 1000 : rawTs;
            const valueChangedInPlace = params.expectedCredFingerprintAtDispatch !== undefined
              && currentFingerprint !== params.expectedCredFingerprintAtDispatch;
            const unconfirmableSameIdUpdate = epochChanged && currentFingerprint === undefined;
            const timestampNewer = credTs !== undefined && credTs > params.startedAt;
            if (valueChangedInPlace || unconfirmableSameIdUpdate || timestampNewer || anotherActiveCredExists) {
              preservedNewerCred = true;
            } else if (!aborted()) {
              await credentialApi.remove({ credentialID: String(matched.id) });
              clearedStoredCred = true;
              this.openCodeCredentialProvenanceDirty = true;
              if (this.knownActiveOpenCodeCredId === matched.id) {
                this.knownActiveOpenCodeCredId = undefined;
                this.knownActiveOpenCodeCredFingerprint = undefined;
              }
              if (aborted()) return;
            }
          }
        }

        if (!clearedStoredCred && !preservedNewerCred && opencodeCreds.length > 0) {
          throw new Error(
            'Expired OpenCode credential provenance could not be confirmed; stored credentials were preserved',
          );
        }
      }
      this.modelCache = null;
      const refreshed = await this.listModels(true);
      if (aborted()) return;

      const previousModel = state.model;
      const stillAvailable = previousModel ? refreshed.models.some((m) => m.id === previousModel) : false;
      if (!stillAvailable) {
        const hasDefaultOpenCodeModel = refreshed.models.some((m) => m.id === DEFAULT_OPENCODE_MODEL_ID);
        if (!hasDefaultOpenCodeModel) {
          throw new Error(
            `OpenCode fallback model "${DEFAULT_OPENCODE_MODEL_ID}" is unavailable after clearing expired credentials`,
          );
        }
        state.model = DEFAULT_OPENCODE_MODEL_ID;
      }
      state.appliedModelSignature = null;
      this.emitSessionInfo(state);

      const retryMessageId = openCodeAuthHealRetryMessageId(state.providerSessionId, params.messageId);
      state.deliveryMessageId = retryMessageId;
      state.currentMessageId = null;
      state.activeStepProviderId = undefined;
      state.retryTerminalHint = null;
      state.retryTerminalError = undefined;
      state.retryActivitySeq = 0;
      state.textParts.clear();
      state.toolNames.clear();
      state.toolInputs.clear();
      state.toolSignatures.clear();
      state.lastUsageSignature = null;
      state.lastUsage = undefined;
      state.lastUsageMessageId = null;

      await state.ensureEvents();
      if (aborted()) return;
      await this.withProviderSessionLock(state.providerSessionId, async () => {
        if (aborted()) return;
        this.assertRouteOwner(state);
        await this.syncSessionModelAndEffort(state);
        if (aborted()) return;
        this.assertRouteOwner(state);
        await this.applySystemInstruction(state, params.system);
        if (aborted()) return;
        this.assertRouteOwner(state);
        this.emitStatus(state.routeId, { status: 'working', label: 'OpenCode is working…' });
        state.authHealPhase = 'retry-dispatched';
        state.authHealRetryAcked = false;
        state.authHealInFlight = false;
        const admissionAbort = new AbortController();
        state.pendingAdmissionAbort = admissionAbort;
        try {
          await withOpenCodeRequestTimeout(
            invokeWithOptionalSignal(
              state.client.sessions.prompt,
              {
                sessionID: state.providerSessionId,
                id: retryMessageId,
                text: params.text,
                ...(params.files.length > 0 ? { files: params.files } : {}),
              },
              admissionAbort.signal,
            ),
            'auth-heal retry prompt',
            admissionAbort,
          );
        } finally {
          if (state.pendingAdmissionAbort === admissionAbort) {
            state.pendingAdmissionAbort = null;
          }
        }
      });
      if (aborted()) return;
      state.authHealRetryAcked = true;
    } catch (healError) {
      state.authHealInFlight = false;
      state.authHealPhase = 'none';
      if (aborted()) return;
      this.failOnce(
        state,
        providerError(
          PROVIDER_ERROR_CODES.AUTH_FAILED,
          `OpenCode API key is expired or invalid and automatic recovery failed (${errorMessage(healError)}; original: ${errorMessage(rawError)}). Check OPENCODE_API_KEY or re-authenticate OpenCode.`,
          false,
        ),
      );
    } finally {
      if (state.authHealInFlight && this.isCurrent(state, healGeneration)) {
        state.authHealInFlight = false;
      }
    }
  }

  private failOnce(state: OpenCodeSessionState, error: ProviderError): void {
    if (state.completionEmitted || state.terminalErrorEmitted) return;
    state.terminalErrorEmitted = true;
    state.busy = false;
    state.compacting = false;
    state.compactRequest = null;
    state.authHealInFlight = false;
    state.retryTerminalReconcileInFlight = false;
    state.retryTerminalHint = null;
    state.retryTerminalError = undefined;
    state.activeTurnParams = null;
    if (!state.cancelled) {
      // Revoke in-flight turn generation so suspended preprocessing/recovery exits immediately after feed drops or errors.
      state.generation += 1;
    }
    this.emitStatus(state.routeId, { status: null, label: null });
    this.emitError(state.routeId, error);
  }

  private emitSessionInfo(state: OpenCodeSessionState): void {
    const storageOwner = this.transportResolution?.mode === OPENCODE_TRANSPORT_MODES.V2_CLI
      ? 'v2-cli'
      : this.transportResolution?.mode === OPENCODE_TRANSPORT_MODES.EMBEDDED
        ? 'embedded'
        : undefined;
    const info: SessionInfoUpdate = {
      resumeId: state.providerSessionId,
      ...(storageOwner ? { openCodeStorageOwner: storageOwner } : {}),
      ...(state.model ? { model: state.model } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
    };
    for (const callback of this.sessionInfoCallbacks) callback(state.routeId, info);
  }

  private emitStatus(routeId: string, status: ProviderStatusUpdate): void {
    for (const callback of this.statusCallbacks) callback(routeId, status);
  }

  private emitError(routeId: string, error: ProviderError): void {
    for (const callback of this.errorCallbacks) callback(routeId, error);
  }

  private isCurrent(state: OpenCodeSessionState, generation: number): boolean {
    return this.sessions.get(state.routeId) === state && state.generation === generation;
  }

  private assertConnected(): OpenCodeClientLike {
    if (!this.client) throw providerError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'OpenCode SDK provider is not connected', true);
    return this.client;
  }

  private normalizeError(error: unknown, operation: string): ProviderError {
    if (error && typeof error === 'object' && 'code' in error && 'recoverable' in error && 'message' in error) {
      return error as ProviderError;
    }
    const status = errorHttpStatus(error);
    const message = redactSecretText(errorMessage(error), []);
    const lower = message.toLowerCase();
    const errorType = error && typeof error === 'object' ? safeString((error as { type?: unknown }).type)?.toLowerCase() ?? '' : '';
    const errorName = error && typeof error === 'object' ? safeString((error as { name?: unknown }).name)?.toLowerCase() ?? '' : '';

    if (
      lower.includes('enoent')
      || lower.includes('err_module_not_found')
      || (lower.includes('opencode') && (lower.includes('cannot find package') || (lower.includes('not found') && lower.includes('package'))))
    ) {
      return providerError(
        PROVIDER_ERROR_CODES.CONFIG_ERROR,
        'OpenCode SDK runtime is unavailable. Ensure `@opencode/sdk` (>= 2.4.2) is installed; if connecting to an external OpenCode server, upgrade it via `opencode upgrade --major`.',
        false,
      );
    }
    if (lower.includes('unsupportedcontenttype') || (errorName === 'clienterror' && (status === 404 || status === 405 || lower.includes('unexpectedstatus')))) {
      return providerError(
        PROVIDER_ERROR_CODES.CONFIG_ERROR,
        `OpenCode ${operation} failed against an incompatible OpenCode v1 endpoint: ${message}. Upgrade the OpenCode runtime to v2 (opencode upgrade --major).`,
        false,
      );
    }
    if (
      errorName.includes('signedout')
      || errorName.includes('ssorequired')
      || lower.includes('providerautherror')
      || lower.includes('unauthorized')
      || lower.includes('authentication')
      || status === 401
      || status === 403
    ) {
      return providerError(PROVIDER_ERROR_CODES.AUTH_FAILED, `OpenCode ${operation} failed: ${message}`, false);
    }
    if (
      errorType.includes('free-limit')
      || errorType.includes('rate-limit')
      || lower.includes('free usage limit')
      || (lower.includes('rate') && lower.includes('limit'))
      || status === 429
    ) {
      const isFreeLimit = errorType.includes('free-limit') || lower.includes('free usage limit');
      const hint = isFreeLimit && this.transportResolution?.mode === OPENCODE_TRANSPORT_MODES.EMBEDDED
        ? ' Install the official OpenCode CLI (`opencode`) or configure a provider API key to avoid embedded free-tier limits.'
        : '';
      return providerError(PROVIDER_ERROR_CODES.RATE_LIMITED, `OpenCode ${operation} failed: ${message}${hint}`, true);
    }
    if (lower.includes('abort') || lower.includes('cancel')) {
      return providerError(PROVIDER_ERROR_CODES.CANCELLED, `OpenCode ${operation} cancelled`, true);
    }
    if (errorName.includes('sessionnotfound') || status === 404 || (lower.includes('session') && lower.includes('not found'))) {
      return providerError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `OpenCode session was not found during ${operation}`, false);
    }
    if (isTransientRequestFailure(error)) {
      return providerError(PROVIDER_ERROR_CODES.CONNECTION_LOST, `OpenCode ${operation} failed: ${message}`, true);
    }
    return providerError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, `OpenCode ${operation} failed: ${message}`, true);
  }
}
