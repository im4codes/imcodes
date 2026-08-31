import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
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
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';

const LOOPBACK_HOST = '127.0.0.1';
const MODEL_CACHE_TTL_MS = 30_000;
// OpenCode loads its models.dev catalog (including each model's `limit.context`)
// asynchronously after an `opencode serve` process starts. A session created in
// that window primes the model→context-window map from a catalog that still
// lacks limits, so usage frames ship without an authoritative window and the UI
// falls back to a 1M guess. When a live usage frame can't resolve its model's
// window we force one throttled catalog refetch so the next frame self-heals.
const CONTEXT_WINDOW_REFRESH_MIN_INTERVAL_MS = 3_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;
const PROMPT_ACCEPTANCE_RECHECK_DELAYS_MS = [0, 100, 250, 500, 1_000] as const;
const MISSING_FINAL_RECOVERY_TIMEOUT_MS = 15_000;
const MISSING_FINAL_RECOVERY_RECHECK_DELAYS_MS = [250, 1_000] as const;
type PromptAcceptance = 'accepted' | 'absent' | 'unknown';
const OPENCODE_PERMISSION_EVENT = {
  LEGACY_UPDATED: 'permission.updated',
  ASKED: 'permission.asked',
  V2_ASKED: 'permission.v2.asked',
} as const;
const OPENCODE_PERMISSION_REPLY_MODE = {
  LEGACY: 'legacy',
  REQUEST: 'request',
} as const;
const MISSING_FINAL_RECOVERY_PROMPT = [
  'The previous tool step finished, but you returned no final response.',
  "Continue from the existing results and answer the user's original request now.",
  'Do not repeat completed tool calls unless the existing result is insufficient.',
].join(' ');

type SdkResult<T> = Promise<{ data: T; response?: { status?: number } }>;

interface OpenCodeClientLike {
  session: {
    create(options: Record<string, unknown>): SdkResult<Record<string, any>>;
    get(options: Record<string, unknown>): SdkResult<Record<string, any>>;
    list(options?: Record<string, unknown>): SdkResult<Array<Record<string, any>>>;
    message(options: Record<string, unknown>): SdkResult<Record<string, any>>;
    messages(options: Record<string, unknown>): SdkResult<Array<Record<string, any>>>;
    prompt(options: Record<string, unknown>): SdkResult<Record<string, any>>;
    promptAsync(options: Record<string, unknown>): SdkResult<void>;
    abort(options: Record<string, unknown>): SdkResult<boolean>;
  };
  provider: {
    list(options?: Record<string, unknown>): SdkResult<Record<string, any>>;
  };
  event: {
    subscribe(options?: Record<string, unknown>): Promise<{ stream: AsyncIterable<Record<string, any>> }>;
  };
  permission?: {
    reply(options: Record<string, unknown>): SdkResult<boolean>;
  };
  postSessionIdPermissionsPermissionId(options: Record<string, unknown>): SdkResult<boolean>;
  notificationSession?: {
    prompt(options: Record<string, unknown>, requestOptions?: Record<string, unknown>): SdkResult<Record<string, any>>;
  };
}

interface OpenCodeServerLike {
  url: string;
  close(): void;
}

export interface OpenCodeSdkRuntimeHooks {
  start(options: { hostname: string; port: number; timeout: number; signal: AbortSignal; config?: Record<string, unknown> }): Promise<{
    client: OpenCodeClientLike;
    server: OpenCodeServerLike;
  }>;
}

export const openCodeSdkRuntimeHooks: OpenCodeSdkRuntimeHooks = {
  async start(options) {
    const [sdk, v2Sdk] = await Promise.all([
      import('@opencode-ai/sdk'),
      import('@opencode-ai/sdk/v2/client'),
    ]);
    const started = await sdk.createOpencode(options);
    const v2Client = v2Sdk.createOpencodeClient({ baseUrl: started.server.url });
    Object.assign(started.client, {
      permission: v2Client.permission,
      notificationSession: v2Client.session,
    });
    return started as unknown as {
      client: OpenCodeClientLike;
      server: OpenCodeServerLike;
    };
  },
};

type OpenCodePermissionReplyMode = typeof OPENCODE_PERMISSION_REPLY_MODE[keyof typeof OPENCODE_PERMISSION_REPLY_MODE];

interface NormalizedOpenCodePermission {
  id: string;
  operation?: string;
  title?: string;
  pattern?: string;
  callId?: string;
  replyMode: OpenCodePermissionReplyMode;
}

interface PendingOpenCodePermission {
  timer: ReturnType<typeof setTimeout>;
  replyMode: OpenCodePermissionReplyMode;
}

interface OpenCodeSessionState {
  routeId: string;
  providerSessionId: string;
  cwd: string;
  model?: string;
  busy: boolean;
  generation: number;
  cancelled: boolean;
  completionEmitted: boolean;
  terminalErrorEmitted: boolean;
  missingFinalRecoveryAttempted: boolean;
  missingFinalRecoveryInFlight: boolean;
  cronControlActive: boolean;
  silentToolResult: string | null;
  deliveryMessageId: string | null;
  currentMessageId: string | null;
  messageRoles: Map<string, 'user' | 'assistant'>;
  pendingParts: Map<string, Array<{ part: Record<string, any>; delta?: string }>>;
  textParts: Map<string, string>;
  toolSignatures: Map<string, string>;
  lastUsageSignature: string | null;
  lastUsage: ProviderUsageUpdate['usage'];
  lastUsageMessageId: string | null;
  client: OpenCodeClientLike;
  server: OpenCodeServerLike;
  abort: AbortController;
  eventLoop: Promise<void>;
  pendingPermissions: Map<string, PendingOpenCodePermission>;
  runtimeConfig: SessionConfig;
}

class OpenCodeRequestTimeoutError extends Error {
  constructor(operation: string) {
    super(`OpenCode ${operation} timed out after ${MISSING_FINAL_RECOVERY_TIMEOUT_MS}ms`);
    this.name = 'OpenCodeRequestTimeoutError';
  }
}

function withOpenCodeRequestTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new OpenCodeRequestTimeoutError(operation)),
      MISSING_FINAL_RECOVERY_TIMEOUT_MS,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
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
  return /\b404\b/.test(errorMessage(error));
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

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isTerminalAssistantMessage(info: Record<string, any> | undefined): boolean {
  if (!info || info.role !== 'assistant') return false;
  if (info.error) return true;
  const finish = safeString(info.finish)?.toLowerCase();
  // OpenCode completes a separate assistant message for every model/tool step.
  // Those intermediate messages carry both time.completed and finish=tool-calls
  // (or finish=unknown), while the same user turn continues with another
  // assistant message. Only an explicit final finish ends the IM.codes turn;
  // session.idle remains the fallback for providers that omit a final reason.
  return finish !== undefined && finish !== 'tool-calls' && finish !== 'unknown';
}

function sessionIdFromEvent(event: Record<string, any>): string | undefined {
  const properties = event.properties;
  return safeString(properties?.sessionID)
    ?? safeString(properties?.part?.sessionID)
    ?? safeString(properties?.info?.sessionID);
}

function permissionPattern(value: unknown): string | undefined {
  if (!Array.isArray(value)) return safeString(value);
  const items = value.map(safeString).filter((item): item is string => item !== undefined);
  return items.length > 0 ? items.join(', ') : undefined;
}

function normalizePermissionEvent(
  eventType: unknown,
  properties: Record<string, any> | undefined,
): NormalizedOpenCodePermission | undefined {
  const id = safeString(properties?.id);
  if (!id) return undefined;
  if (eventType === OPENCODE_PERMISSION_EVENT.LEGACY_UPDATED) {
    return {
      id,
      operation: safeString(properties?.type),
      title: safeString(properties?.title),
      pattern: permissionPattern(properties?.pattern),
      callId: safeString(properties?.callID),
      replyMode: OPENCODE_PERMISSION_REPLY_MODE.LEGACY,
    };
  }
  if (eventType === OPENCODE_PERMISSION_EVENT.ASKED) {
    return {
      id,
      operation: safeString(properties?.permission),
      pattern: permissionPattern(properties?.patterns),
      callId: safeString(properties?.tool?.callID),
      replyMode: OPENCODE_PERMISSION_REPLY_MODE.REQUEST,
    };
  }
  if (eventType === OPENCODE_PERMISSION_EVENT.V2_ASKED) {
    return {
      id,
      operation: safeString(properties?.action),
      pattern: permissionPattern(properties?.resources),
      callId: safeString(properties?.source?.callID),
      replyMode: OPENCODE_PERMISSION_REPLY_MODE.REQUEST,
    };
  }
  return undefined;
}

function parseModelIdentity(value: string | undefined): { providerID: string; modelID: string } | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

function providerError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
  return { code, message, recoverable, ...(details === undefined ? {} : { details }) };
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function attachmentParts(attachments: TransportAttachment[] | undefined): Array<Record<string, unknown>> {
  return (attachments ?? []).map((attachment) => ({
    type: 'file',
    mime: attachment.mime || (attachment.type === 'image' ? 'image/*' : 'application/octet-stream'),
    ...(attachment.originalName ? { filename: attachment.originalName } : {}),
    url: pathToFileURL(attachment.daemonPath).href,
  }));
}

export class OpenCodeSdkProvider implements TransportProvider {
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
    contextSupport: 'full-normalized-context-injection',
    activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
    restartDurableDeliveryId: {
      restartDurable: true,
      replayAfterAcceptance: 'deduplicated',
    },
  };

  private client: OpenCodeClientLike | null = null;
  private server: OpenCodeServerLike | null = null;
  private lifecycleAbort: AbortController | null = null;
  private sessions = new Map<string, OpenCodeSessionState>();
  private providerToRoute = new Map<string, string>();
  private providerRouteOrder = new Map<string, string[]>();
  private modelCache: { at: number; value: ProviderModelList } | null = null;
  private modelContextWindows = new Map<string, number>();
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

  async connect(config: ProviderConfig): Promise<void> {
    if (this.client && this.server) return;
    const abort = new AbortController();
    const port = positiveNumber(config.port) || await reserveLoopbackPort();
    const timeout = positiveNumber(config.startupTimeoutMs) || 10_000;
    try {
      const started = await openCodeSdkRuntimeHooks.start({
        hostname: LOOPBACK_HOST,
        port,
        timeout,
        signal: abort.signal,
      });
      const url = new URL(started.server.url);
      if (url.hostname !== LOOPBACK_HOST && url.hostname !== 'localhost' && url.hostname !== '::1') {
        started.server.close();
        throw providerError(PROVIDER_ERROR_CODES.CONFIG_ERROR, 'OpenCode SDK server did not bind to loopback', false);
      }
      this.client = started.client;
      this.server = started.server;
      this.lifecycleAbort = abort;
      this.approvalTimeoutMs = positiveNumber(config.approvalTimeoutMs) || DEFAULT_APPROVAL_TIMEOUT_MS;
      logger.info({ provider: this.id, server: url.origin }, 'OpenCode SDK provider connected');
    } catch (error) {
      abort.abort();
      this.server?.close();
      this.server = null;
      this.client = null;
      this.lifecycleAbort = null;
      throw this.normalizeError(error, 'connect');
    }
  }

  async disconnect(): Promise<void> {
    const states = [...this.sessions.values()];
    this.sessions.clear();
    this.providerToRoute.clear();
    this.providerRouteOrder.clear();
    for (const state of states) await this.closeSessionState(state);
    this.lifecycleAbort?.abort();
    this.lifecycleAbort = null;
    this.server?.close();
    this.server = null;
    this.client = null;
    this.modelCache = null;
    this.modelContextWindows.clear();
    this.lastContextWindowRefreshAt = 0;
    this.contextWindowRefreshInFlight = false;
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    return {
      providerId: this.id,
      status: this.client ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: Boolean(this.client),
      degradedReasons: [],
    };
  }

  async createSession(config: SessionConfig): Promise<string> {
    this.assertConnected();
    // Usage events contain token counts but not the model limit. Prime the
    // provider catalog before the session starts so the first usage frame can
    // carry OpenCode's authoritative context window instead of a guessed UI
    // fallback. listModels() is locally cached and fails closed to an empty
    // catalog without preventing session creation.
    if (!this.modelCache) await this.listModels(false);
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existing = this.sessions.get(routeId);
    if (existing && !config.fresh) {
      if (safeString(config.agentId)) existing.model = config.agentId!.trim();
      this.emitSessionInfo(existing);
      return routeId;
    }
    if (existing) await this.endSession(routeId);

    const cwd = safeString(config.cwd) ?? process.cwd();
    const sessionRuntime = await this.startSessionRuntime(config, cwd);
    let info: Record<string, any>;
    if (config.skipCreate && safeString(config.resumeId)) {
      try {
        info = (await sessionRuntime.client.session.get({
          path: { id: config.resumeId },
          query: { directory: cwd },
          throwOnError: true,
        })).data;
      } catch (error) {
        await this.closeStartedRuntime(sessionRuntime);
        throw this.normalizeError(error, 'restore');
      }
    } else {
      try {
        info = (await sessionRuntime.client.session.create({
          query: { directory: cwd },
          body: { title: safeString(config.label) ?? config.sessionName ?? config.sessionKey },
          throwOnError: true,
        })).data;
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
    const state: OpenCodeSessionState = {
      routeId,
      providerSessionId,
      cwd,
      model: safeString(config.agentId),
      busy: false,
      generation: 0,
      cancelled: false,
      completionEmitted: false,
      terminalErrorEmitted: false,
      missingFinalRecoveryAttempted: false,
      missingFinalRecoveryInFlight: false,
      cronControlActive: false,
      silentToolResult: null,
      deliveryMessageId: null,
      currentMessageId: null,
      messageRoles: new Map(),
      pendingParts: new Map(),
      textParts: new Map(),
      toolSignatures: new Map(),
      lastUsageSignature: null,
      lastUsage: undefined,
      lastUsageMessageId: null,
      client: sessionRuntime.client,
      server: sessionRuntime.server,
      abort: sessionRuntime.abort,
      eventLoop: Promise.resolve(),
      pendingPermissions: new Map(),
      runtimeConfig: { ...config },
    };
    this.sessions.set(routeId, state);
    this.registerProviderRoute(providerSessionId, routeId);
    state.eventLoop = this.consumeEvents(sessionRuntime.stream, sessionRuntime.abort.signal);
    this.emitSessionInfo(state);
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(state.routeId);
    const removedSoleProviderRoute = this.releaseProviderRoute(state);
    if (state.busy && removedSoleProviderRoute) {
      await state.client.session.abort({
        path: { id: state.providerSessionId },
        query: { directory: state.cwd },
        throwOnError: true,
      }).catch(() => {});
    }
    await this.closeSessionState(state);
  }

  async detachSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(state.routeId);
    this.releaseProviderRoute(state);
    await this.closeSessionState(state);
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    const client = this.assertConnected();
    try {
      const response = await client.session.get({ path: { id: sessionId }, throwOnError: true });
      return safeString(response.data?.id) === sessionId;
    } catch {
      return false;
    }
  }

  async listSessions(options: RemoteSessionListOptions = {}): Promise<RemoteSessionInfo[]> {
    const client = this.assertConnected();
    const directory = safeString(options.directory);
    const result = await client.session.list({
      ...(directory ? { query: { directory } } : {}),
      throwOnError: true,
    });
    return result.data.map((session) => ({
      key: String(session.id),
      ...(safeString(session.title) ? { displayName: session.title.trim() } : {}),
      ...(safeString(session.directory) ? { directory: session.directory.trim() } : {}),
      ...(positiveNumber(session.time?.updated) !== undefined ? { updatedAt: session.time.updated } : {}),
    }));
  }

  async listModels(force = false): Promise<ProviderModelList> {
    if (!force && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_TTL_MS) {
      return this.modelCache.value;
    }
    try {
      const client = this.assertConnected();
      const result = await client.provider.list({ throwOnError: true });
      const connected = new Set(Array.isArray(result.data?.connected) ? result.data.connected : []);
      const providers = Array.isArray(result.data?.all) ? result.data.all : [];
      const nextContextWindows = new Map<string, number>();
      const models = providers
        .filter((provider) => connected.has(provider.id))
        .flatMap((provider) => Object.values(provider.models ?? {}).map((model: any) => {
          const id = `${provider.id}/${model.id}`;
          const contextWindow = positiveNumber(model.limit?.context);
          if (contextWindow !== undefined && contextWindow > 0) nextContextWindows.set(id, contextWindow);
          return {
            id,
            name: `${provider.name} · ${model.name ?? model.id}`,
            ...(model.reasoning ? { supportsReasoningEffort: true } : {}),
          };
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const firstProvider = providers.find((provider) => connected.has(provider.id));
      const defaultModelId = firstProvider ? result.data?.default?.[firstProvider.id] : undefined;
      const value: ProviderModelList = {
        models,
        isAuthenticated: connected.size > 0,
        ...(firstProvider && defaultModelId ? { defaultModel: `${firstProvider.id}/${defaultModelId}` } : {}),
        ...(connected.size === 0 ? { error: 'OpenCode has no connected model provider' } : {}),
      };
      // Merge rather than replace so an authoritative window, once learned,
      // survives a later cold/partial/failed refresh or a transient provider
      // disconnect that drops the model from `connected`. reset() clears the
      // map when the provider fully disconnects.
      for (const [id, windowTokens] of nextContextWindows) this.modelContextWindows.set(id, windowTokens);
      this.modelCache = { at: Date.now(), value };
      return value;
    } catch (error) {
      return { models: [], isAuthenticated: false, error: errorMessage(error) };
    }
  }

  /**
   * OpenCode's per-model `limit.context` can be absent from the first catalog
   * snapshot after a server starts (models.dev loads asynchronously). When a
   * live usage frame cannot resolve its model's window, force one throttled
   * catalog refetch so the next frame carries the authoritative limit instead
   * of the UI's 1M fallback. No-op once the window is known.
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
    const state = this.sessions.get(sessionId);
    if (!state || !agentId.trim()) return;
    state.model = agentId.trim();
    this.emitSessionInfo(state);
  }

  async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw providerError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown OpenCode SDK session: ${sessionId}`, false);
    if (state.busy) throw providerError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'OpenCode session is already busy', true);

    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    const model = parseModelIdentity(state.model);
    const generation = ++state.generation;
    state.busy = true;
    state.cancelled = false;
    state.completionEmitted = false;
    state.terminalErrorEmitted = false;
    state.missingFinalRecoveryAttempted = false;
    state.missingFinalRecoveryInFlight = false;
    state.cronControlActive = payload.assembledMessage.includes(CRON_CONTROL_PROTOCOL.OPEN_TAG);
    state.silentToolResult = null;
    state.deliveryMessageId = null;
    state.currentMessageId = null;
    state.messageRoles.clear();
    state.pendingParts.clear();
    state.textParts.clear();
    state.toolSignatures.clear();
    state.lastUsageSignature = null;
    state.lastUsage = undefined;
    state.lastUsageMessageId = null;
    this.emitStatus(state.routeId, { status: 'working', label: 'OpenCode is working…' });

    const parts: Array<Record<string, unknown>> = [
      { type: 'text', text: payload.assembledMessage },
      ...attachmentParts(payload.attachments),
    ];
    const system = composeProviderSystemText(payload);
    const messageId = openCodePromptMessageId(state.providerSessionId, payload.deliveryId);
    state.deliveryMessageId = messageId;
    try {
      if (await this.hasAcceptedPrompt(state, messageId)) {
        return;
      }
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      await state.client.session.promptAsync({
        path: { id: state.providerSessionId },
        query: { directory: state.cwd },
        body: {
          messageID: messageId,
          ...(model ? { model } : {}),
          ...(system ? { system } : {}),
          parts,
        },
        throwOnError: true,
      });
    } catch (error) {
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      if (isTransientRequestFailure(error)) {
        try {
          const acceptance = await this.waitForPromptAcceptance(state, generation, messageId);
          if (acceptance === 'accepted' || !this.isCurrent(state, generation) || state.cancelled) return;
          if (acceptance === 'unknown') {
            logger.warn(
              { provider: this.id, sessionId: state.routeId, messageId },
              'OpenCode prompt acceptance remained unknown after transient lookup failures; retrying with the same message ID',
            );
          }
        } catch (acceptanceError) {
          state.busy = false;
          this.emitStatus(state.routeId, { status: null, label: null });
          throw this.normalizeError(acceptanceError, 'prompt acceptance check');
        }
      }
      state.busy = false;
      this.emitStatus(state.routeId, { status: null, label: null });
      throw this.normalizeError(error, 'prompt submission');
    }
  }

  async notifyActiveDelegation(
    sessionId: string,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    const state = this.sessions.get(sessionId);
    if (!state?.busy || state.cancelled) return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    if (!state.client.notificationSession) return AGENT_DELEGATION_NOTIFICATION_RESULTS.UNSUPPORTED;
    await state.client.notificationSession.prompt({
      sessionID: state.providerSessionId,
      id: notification.notificationId,
      prompt: { text: notification.text },
      delivery: 'steer',
      resume: true,
    }, { throwOnError: true });
    // A successful prompt RPC is the irreversible provider admission ACK.
    // Do not post-check generation/idle after success: doing so would retain
    // and replay a message that OpenCode has already accepted.
    return AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED;
  }

  async cancel(sessionId: string, options?: ProviderCancelOptions): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || !state.busy) return;
    state.cancelled = true;
    state.generation += 1;
    try {
      await state.client.session.abort({
        path: { id: state.providerSessionId },
        query: { directory: state.cwd },
        throwOnError: true,
      });
    } finally {
      this.failOnce(state, providerError(
        PROVIDER_ERROR_CODES.CANCELLED,
        options?.origin === PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG
          ? 'OpenCode was unresponsive and was automatically recovered.'
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
    const state = this.sessions.get(sessionId);
    if (!state) throw providerError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown OpenCode SDK session: ${sessionId}`, false);
    const pending = state.pendingPermissions.get(requestId);
    if (pending) clearTimeout(pending.timer);
    state.pendingPermissions.delete(requestId);
    await this.replyPermission(
      state,
      requestId,
      approved,
      pending?.replyMode ?? OPENCODE_PERMISSION_REPLY_MODE.LEGACY,
    );
  }

  private async replyPermission(
    state: OpenCodeSessionState,
    requestId: string,
    approved: boolean,
    replyMode: OpenCodePermissionReplyMode,
  ): Promise<void> {
    try {
      if (replyMode === OPENCODE_PERMISSION_REPLY_MODE.REQUEST && state.client.permission) {
        await state.client.permission.reply({
          path: { requestID: requestId },
          query: { directory: state.cwd },
          body: { reply: approved ? 'once' : 'reject' },
          throwOnError: true,
        });
        return;
      }
      await state.client.postSessionIdPermissionsPermissionId({
        path: { id: state.providerSessionId, permissionID: requestId },
        query: { directory: state.cwd },
        body: { response: approved ? 'once' : 'reject' },
        throwOnError: true,
      });
    } catch (error) {
      throw this.normalizeError(error, 'permission');
    }
  }

  private async hasAcceptedPrompt(state: OpenCodeSessionState, messageId: string): Promise<boolean> {
    try {
      const result = await state.client.session.message({
        path: { id: state.providerSessionId, messageID: messageId },
        query: { directory: state.cwd },
        throwOnError: true,
      });
      return safeString(result.data?.info?.id) === messageId
        && result.data?.info?.role === 'user';
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
      if (!this.isCurrent(state, generation) || state.cancelled) return 'unknown';
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

  private async consumeEvents(stream: AsyncIterable<Record<string, any>>, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of stream) {
        if (signal.aborted) return;
        this.handleEvent(event);
      }
      if (!signal.aborted) throw new Error('OpenCode event stream ended');
    } catch (error) {
      if (signal.aborted) return;
      const normalized = this.normalizeError(error, 'events');
      for (const state of this.sessions.values()) {
        if (!state.busy) continue;
        this.failOnce(state, normalized);
      }
    }
  }

  private async startSessionRuntime(config: SessionConfig, cwd: string): Promise<{
    client: OpenCodeClientLike;
    server: OpenCodeServerLike;
    abort: AbortController;
    stream: AsyncIterable<Record<string, any>>;
  }> {
    const abort = new AbortController();
    const port = await reserveLoopbackPort();
    const mcpServers = getDefaultMcpServers(config);
    let started: Awaited<ReturnType<OpenCodeSdkRuntimeHooks['start']>> | null = null;
    const mcp = Object.fromEntries(Object.entries(mcpServers).map(([name, server]) => [name, {
      type: 'local',
      command: [server.command, ...server.args],
      environment: server.env,
      enabled: true,
    }]));
    try {
      started = await openCodeSdkRuntimeHooks.start({
        hostname: LOOPBACK_HOST,
        port,
        timeout: 10_000,
        signal: abort.signal,
        config: { share: 'disabled', mcp },
      });
      const url = new URL(started.server.url);
      if (url.hostname !== LOOPBACK_HOST && url.hostname !== 'localhost' && url.hostname !== '::1') {
        throw providerError(PROVIDER_ERROR_CODES.CONFIG_ERROR, 'OpenCode SDK session server did not bind to loopback', false);
      }
      const subscription = await started.client.event.subscribe({
        query: { directory: cwd },
        signal: abort.signal,
      });
      return { client: started.client, server: started.server, abort, stream: subscription.stream };
    } catch (error) {
      abort.abort();
      started?.server.close();
      throw this.normalizeError(error, 'session server startup');
    }
  }

  private async closeStartedRuntime(runtime: {
    server: OpenCodeServerLike;
    abort: AbortController;
  }): Promise<void> {
    runtime.abort.abort();
    runtime.server.close();
  }

  private async closeSessionState(state: OpenCodeSessionState): Promise<void> {
    for (const pending of state.pendingPermissions.values()) clearTimeout(pending.timer);
    state.pendingPermissions.clear();
    state.abort.abort();
    state.server.close();
    await state.eventLoop.catch(() => {});
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

  private handleEvent(event: Record<string, any>): void {
    const providerSessionId = sessionIdFromEvent(event);
    if (!providerSessionId) return;
    const routeId = this.providerToRoute.get(providerSessionId);
    const state = routeId ? this.sessions.get(routeId) : undefined;
    if (!state) return;
    switch (event.type) {
      case 'message.part.updated':
        this.processPart(state, event.properties?.part, event.properties?.delta);
        return;
      case 'message.updated':
        if (this.processMessage(state, event.properties?.info)) {
          this.completeOnce(state, 'message.updated');
        }
        return;
      case OPENCODE_PERMISSION_EVENT.LEGACY_UPDATED:
      case OPENCODE_PERMISSION_EVENT.ASKED:
      case OPENCODE_PERMISSION_EVENT.V2_ASKED:
        this.processPermission(state, normalizePermissionEvent(event.type, event.properties));
        return;
      case 'session.status': {
        const status = event.properties?.status;
        if (status?.type === 'idle') {
          this.completeOnce(state, 'session.status');
          return;
        }
        // A delayed/stale `busy` or `retry` frame can arrive AFTER the turn has
        // already completed — e.g. when the running tool restarts the network
        // (an OpenClash/VPN restart) and OpenCode flushes its event stream out
        // of order. Re-emitting a progress label here strands the footer on
        // "OpenCode is working…" even though the session is idle. Only surface
        // progress while a turn is actually live; send() re-arms state.busy for
        // the next turn, and completeOnce/failOnce clear it.
        if (!state.busy) return;
        if (status?.type === 'busy') this.emitStatus(state.routeId, { status: 'working', label: 'OpenCode is working…' });
        else if (status?.type === 'retry') this.emitStatus(state.routeId, { status: 'retrying', label: safeString(status.message) ?? 'OpenCode is retrying…' });
        return;
      }
      case 'session.idle':
        this.completeOnce(state, 'session.idle');
        return;
      case 'session.error': {
        this.failOnce(state, this.normalizeError(event.properties?.error, 'session'));
        return;
      }
      default:
        return;
    }
  }

  private processPromptResult(state: OpenCodeSessionState, result: Record<string, any>): boolean {
    const terminal = this.processMessage(state, result?.info);
    if (Array.isArray(result?.parts)) {
      for (const part of result.parts) this.processPart(state, part);
    }
    return terminal;
  }

  private processMessage(state: OpenCodeSessionState, info: Record<string, any> | undefined): boolean {
    if (!info) return false;
    const messageId = safeString(info.id);
    const role = info.role === 'user'
      ? 'user'
      : info.role === 'assistant'
        ? 'assistant'
        : undefined;
    if (!messageId || !role) return false;
    state.messageRoles.set(messageId, role);
    const pendingParts = state.pendingParts.get(messageId);
    state.pendingParts.delete(messageId);
    if (role !== 'assistant') return false;
    state.currentMessageId = messageId;
    for (const pending of pendingParts ?? []) {
      this.processAssistantPart(state, pending.part, pending.delta);
    }
    if (safeString(info.modelID) && safeString(info.providerID)) {
      const model = `${info.providerID}/${info.modelID}`;
      if (state.model !== model) {
        state.model = model;
        this.emitSessionInfo(state);
      }
    }
    this.emitUsage(state, info.id, info.tokens, info.cost, true);
    if (info.error) {
      this.failOnce(state, this.normalizeError(info.error, 'message'));
    }
    return isTerminalAssistantMessage(info);
  }

  private processPart(state: OpenCodeSessionState, part: Record<string, any> | undefined, delta?: string): void {
    if (!part || safeString(part.sessionID) !== state.providerSessionId) return;
    const messageId = safeString(part.messageID);
    if (!messageId) return;
    const role = state.messageRoles.get(messageId);
    if (role === 'user') return;
    if (role !== 'assistant') {
      const pendingParts = state.pendingParts.get(messageId) ?? [];
      pendingParts.push({ part, ...(delta === undefined ? {} : { delta }) });
      state.pendingParts.set(messageId, pendingParts);
      return;
    }
    this.processAssistantPart(state, part, delta);
  }

  private processAssistantPart(state: OpenCodeSessionState, part: Record<string, any>, delta?: string): void {
    // The prompt result can settle the turn before the SSE stream flushes its
    // duplicate reasoning/text/tool parts. Do not let those stale parts revive
    // "thinking" or publish data after completeOnce/failOnce cleared `busy`.
    if (!state.busy) return;
    state.currentMessageId = safeString(part.messageID) ?? state.currentMessageId;
    if (part.type === 'text') {
      const partId = safeString(part.id) ?? randomUUID();
      const previous = state.textParts.get(partId) ?? '';
      const text = typeof part.text === 'string' ? part.text : previous + (delta ?? '');
      if (text === previous) return;
      state.textParts.set(partId, text);
      this.emitTextDelta(state);
      return;
    }
    if (part.type === 'reasoning') {
      this.emitStatus(state.routeId, { status: 'thinking', label: 'OpenCode is thinking…' });
      return;
    }
    if (part.type === 'tool') {
      this.emitTool(state, part);
      return;
    }
    if (part.type === 'step-finish') {
      this.emitUsage(state, part.messageID, part.tokens, part.cost, false);
    }
  }

  private emitTextDelta(state: OpenCodeSessionState): void {
    const content = [...state.textParts.values()].join('');
    if (!content) return;
    const messageId = state.currentMessageId ?? `${state.providerSessionId}:assistant`;
    const update: MessageDelta = { messageId, type: 'text', delta: content, role: 'assistant' };
    for (const callback of this.deltaCallbacks) callback(state.routeId, update);
  }

  private emitTool(state: OpenCodeSessionState, part: Record<string, any>): void {
    const toolState = part.state ?? {};
    const status: ToolCallEvent['status'] = toolState.status === 'completed'
      ? 'complete'
      : toolState.status === 'error'
        ? 'error'
        : 'running';
    const id = safeString(part.callID) ?? safeString(part.id) ?? randomUUID();
    const signature = JSON.stringify([status, toolState.input, toolState.output, toolState.error]);
    if (state.toolSignatures.get(id) === signature) return;
    state.toolSignatures.set(id, signature);
    const event: ToolCallEvent = {
      id,
      name: safeString(part.tool) ?? 'tool',
      status,
      ...(toolState.input !== undefined ? { input: toolState.input } : {}),
      ...(typeof toolState.output === 'string' ? { output: toolState.output } : {}),
      ...(status === 'error' && safeString(toolState.error) ? { output: toolState.error } : {}),
      detail: {
        kind: 'opencode.tool',
        summary: safeString(toolState.title) ?? safeString(part.tool) ?? 'tool',
        input: toolState.input,
        output: toolState.output ?? toolState.error,
        meta: { provider: this.id, providerSessionId: state.providerSessionId },
      },
    };
    for (const callback of this.toolCallbacks) callback(state.routeId, event);
    if (
      status === 'complete'
      && state.cronControlActive
      && isCronSilentResult(toolState.output)
    ) {
      state.silentToolResult = CRON_CONTROL_PROTOCOL.SILENT_RESULT;
      this.finishOnce(state, CRON_CONTROL_PROTOCOL.SILENT_RESULT, 'cron.tool.silent');
      // Do not abort the provider turn here. An asynchronous abort can race
      // with the next queued turn and cancel unrelated work. finishOnce makes
      // SILENT terminal for IM.codes and generation guards ignore late events.
    }
  }

  private processPermission(state: OpenCodeSessionState, permission: NormalizedOpenCodePermission | undefined): void {
    if (!permission) return;
    const { id, operation, title, pattern, callId, replyMode } = permission;
    const request: ApprovalRequest = {
      id,
      description: title ?? `Allow OpenCode ${operation ?? 'operation'}${pattern ? `: ${pattern}` : ''}`,
      ...(operation ? { tool: operation } : {}),
      provider: this.id,
      providerGeneration: state.generation,
      ...(callId ? { providerToolUseId: callId } : {}),
      ...(pattern ? { inputPreview: pattern.slice(0, 300) } : {}),
    };
    if (this.approvalCallbacks.length === 0) {
      void this.replyPermission(state, id, false, replyMode).catch((error) => {
        this.emitError(state.routeId, this.normalizeError(error, 'permission rejection'));
      });
      return;
    }
    const prior = state.pendingPermissions.get(id);
    if (prior) {
      if (replyMode === OPENCODE_PERMISSION_REPLY_MODE.REQUEST
        && prior.replyMode !== OPENCODE_PERMISSION_REPLY_MODE.REQUEST) {
        state.pendingPermissions.set(id, { ...prior, replyMode });
      }
      return;
    }
    const timer = setTimeout(() => {
      const pending = state.pendingPermissions.get(id);
      if (!pending) return;
      state.pendingPermissions.delete(id);
      void this.replyPermission(state, id, false, pending.replyMode).catch((error) => {
        this.emitError(state.routeId, this.normalizeError(error, 'permission timeout'));
      });
    }, this.approvalTimeoutMs);
    timer.unref?.();
    state.pendingPermissions.set(id, { timer, replyMode });
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

    // OpenCode emits an initial assistant message with an all-zero token
    // placeholder before the authoritative step-finish/final message. Expose
    // the provider context limit without publishing that placeholder as a
    // finalized zero-token snapshot, which would otherwise win the completion
    // race and leave the persisted timeline at 0 usage.
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
      // A terminal message.updated frame can precede its text part. Wait for
      // prompt.result or an idle authority before deciding the turn is empty.
      if (source === 'message.updated' || state.missingFinalRecoveryInFlight) return;
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
    await withOpenCodeRequestTimeout(state.client.session.get({
      path: { id: state.providerSessionId },
      query: { directory: state.cwd },
      throwOnError: true,
    }), 'session health check');

    const accepted = await withOpenCodeRequestTimeout(
      this.hasAcceptedPrompt(state, recoveryMessageId),
      'missing final acceptance check',
    );
    if (accepted) return this.loadAcceptedRecoveryResult(state, recoveryMessageId);

    const model = parseModelIdentity(state.model);
    const result = await withOpenCodeRequestTimeout(state.client.session.prompt({
      path: { id: state.providerSessionId },
      query: { directory: state.cwd },
      body: {
        messageID: recoveryMessageId,
        ...(model ? { model } : {}),
        parts: [{ type: 'text', text: MISSING_FINAL_RECOVERY_PROMPT }],
      },
      throwOnError: true,
    }), 'missing final recovery prompt');
    return this.processPromptResult(state, result.data);
  }

  private async loadAcceptedRecoveryResult(
    state: OpenCodeSessionState,
    recoveryMessageId: string,
  ): Promise<boolean> {
    const result = await withOpenCodeRequestTimeout(state.client.session.messages({
      path: { id: state.providerSessionId },
      query: { directory: state.cwd, limit: 100 },
      throwOnError: true,
    }), 'missing final recovery reconciliation');
    const recovered = [...result.data].reverse().find((message) => (
      message?.info?.role === 'assistant'
      && safeString(message.info.parentID) === recoveryMessageId
      && isTerminalAssistantMessage(message.info)
    ));
    return recovered ? this.processPromptResult(state, recovered) : false;
  }

  private async restartSessionRuntime(state: OpenCodeSessionState, generation: number): Promise<boolean> {
    const replacement = await this.startSessionRuntime(state.runtimeConfig, state.cwd);
    try {
      await withOpenCodeRequestTimeout(replacement.client.session.get({
        path: { id: state.providerSessionId },
        query: { directory: state.cwd },
        throwOnError: true,
      }), 'session reconnect verification');
    } catch (error) {
      await this.closeStartedRuntime(replacement);
      throw error;
    }

    // Cancellation or a newer send may win while the replacement server is
    // starting. Never attach that stale runtime after its owning turn ended.
    if (!this.isCurrent(state, generation) || state.cancelled) {
      await this.closeStartedRuntime(replacement);
      return false;
    }

    const previous = {
      abort: state.abort,
      server: state.server,
      eventLoop: state.eventLoop,
    };
    state.client = replacement.client;
    state.server = replacement.server;
    state.abort = replacement.abort;
    state.eventLoop = this.consumeEvents(replacement.stream, replacement.abort.signal);
    previous.abort.abort();
    previous.server.close();
    void previous.eventLoop.catch(() => {});
    logger.warn(
      { provider: this.id, sessionId: state.routeId, providerSessionId: state.providerSessionId },
      'OpenCode session server reconnected during missing-final recovery',
    );
    return true;
  }

  private failOnce(state: OpenCodeSessionState, error: ProviderError): void {
    if (state.completionEmitted || state.terminalErrorEmitted) return;
    state.terminalErrorEmitted = true;
    state.busy = false;
    this.emitStatus(state.routeId, { status: null, label: null });
    this.emitError(state.routeId, error);
  }

  private emitSessionInfo(state: OpenCodeSessionState): void {
    const info: SessionInfoUpdate = {
      resumeId: state.providerSessionId,
      ...(state.model ? { model: state.model } : {}),
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
    const message = errorMessage(error);
    const lower = message.toLowerCase();
    if (lower.includes('enoent') || lower.includes('not found') && lower.includes('opencode')) {
      return providerError(
        PROVIDER_ERROR_CODES.CONFIG_ERROR,
        'OpenCode executable is not installed or not available on PATH. Install OpenCode before using the OpenCode SDK agent.',
        false,
      );
    }
    if (lower.includes('providerautherror') || lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('401')) {
      return providerError(PROVIDER_ERROR_CODES.AUTH_FAILED, `OpenCode ${operation} failed: ${message}`, false);
    }
    if (lower.includes('rate') && lower.includes('limit') || lower.includes('429')) {
      return providerError(PROVIDER_ERROR_CODES.RATE_LIMITED, `OpenCode ${operation} failed: ${message}`, true);
    }
    if (lower.includes('abort') || lower.includes('cancel')) {
      return providerError(PROVIDER_ERROR_CODES.CANCELLED, `OpenCode ${operation} cancelled`, true);
    }
    if (lower.includes('404') || lower.includes('session') && lower.includes('not found')) {
      return providerError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `OpenCode session was not found during ${operation}`, false);
    }
    if (isTransientRequestFailure(error)) {
      return providerError(PROVIDER_ERROR_CODES.CONNECTION_LOST, `OpenCode ${operation} failed: ${message}`, true);
    }
    return providerError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, `OpenCode ${operation} failed: ${message}`, true);
  }
}
