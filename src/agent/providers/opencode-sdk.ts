import { randomUUID } from 'node:crypto';
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
  SessionConfig,
  SessionInfoUpdate,
  TransportProvider,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { MEMORY_MCP_STATUS, type MemoryMcpProviderStatusView } from '../../../shared/memory-ws.js';
import { composeProviderSystemText } from '../provider-context-routing.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import logger from '../../util/logger.js';

const LOOPBACK_HOST = '127.0.0.1';
const MODEL_CACHE_TTL_MS = 30_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

type SdkResult<T> = Promise<{ data: T; response?: { status?: number } }>;

interface OpenCodeClientLike {
  session: {
    create(options: Record<string, unknown>): SdkResult<Record<string, any>>;
    get(options: Record<string, unknown>): SdkResult<Record<string, any>>;
    list(options?: Record<string, unknown>): SdkResult<Array<Record<string, any>>>;
    prompt(options: Record<string, unknown>): SdkResult<Record<string, any>>;
    abort(options: Record<string, unknown>): SdkResult<boolean>;
  };
  provider: {
    list(options?: Record<string, unknown>): SdkResult<Record<string, any>>;
  };
  event: {
    subscribe(options?: Record<string, unknown>): Promise<{ stream: AsyncIterable<Record<string, any>> }>;
  };
  postSessionIdPermissionsPermissionId(options: Record<string, unknown>): SdkResult<boolean>;
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
    const sdk = await import('@opencode-ai/sdk');
    return sdk.createOpencode(options) as unknown as Promise<{
      client: OpenCodeClientLike;
      server: OpenCodeServerLike;
    }>;
  },
};

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
  currentMessageId: string | null;
  textParts: Map<string, string>;
  toolSignatures: Map<string, string>;
  lastUsageSignature: string | null;
  client: OpenCodeClientLike;
  server: OpenCodeServerLike;
  abort: AbortController;
  eventLoop: Promise<void>;
  pendingPermissions: Map<string, ReturnType<typeof setTimeout>>;
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

function sessionIdFromEvent(event: Record<string, any>): string | undefined {
  const properties = event.properties;
  return safeString(properties?.sessionID)
    ?? safeString(properties?.part?.sessionID)
    ?? safeString(properties?.info?.sessionID);
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
  };

  private client: OpenCodeClientLike | null = null;
  private server: OpenCodeServerLike | null = null;
  private lifecycleAbort: AbortController | null = null;
  private sessions = new Map<string, OpenCodeSessionState>();
  private providerToRoute = new Map<string, string>();
  private modelCache: { at: number; value: ProviderModelList } | null = null;
  private modelContextWindows = new Map<string, number>();
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
    for (const state of states) await this.closeSessionState(state);
    this.lifecycleAbort?.abort();
    this.lifecycleAbort = null;
    this.server?.close();
    this.server = null;
    this.client = null;
    this.modelCache = null;
    this.modelContextWindows.clear();
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
      currentMessageId: null,
      textParts: new Map(),
      toolSignatures: new Map(),
      lastUsageSignature: null,
      client: sessionRuntime.client,
      server: sessionRuntime.server,
      abort: sessionRuntime.abort,
      eventLoop: Promise.resolve(),
      pendingPermissions: new Map(),
    };
    this.sessions.set(routeId, state);
    this.providerToRoute.set(providerSessionId, routeId);
    state.eventLoop = this.consumeEvents(sessionRuntime.stream, sessionRuntime.abort.signal);
    this.emitSessionInfo(state);
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(state.routeId);
    this.providerToRoute.delete(state.providerSessionId);
    if (state.busy) {
      await state.client.session.abort({
        path: { id: state.providerSessionId },
        query: { directory: state.cwd },
        throwOnError: true,
      }).catch(() => {});
    }
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

  async listSessions(): Promise<RemoteSessionInfo[]> {
    const client = this.assertConnected();
    const result = await client.session.list({ throwOnError: true });
    return result.data.map((session) => ({
      key: String(session.id),
      ...(safeString(session.title) ? { displayName: session.title.trim() } : {}),
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
      this.modelContextWindows = nextContextWindows;
      this.modelCache = { at: Date.now(), value };
      return value;
    } catch (error) {
      return { models: [], isAuthenticated: false, error: errorMessage(error) };
    }
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
    state.currentMessageId = null;
    state.textParts.clear();
    state.toolSignatures.clear();
    state.lastUsageSignature = null;
    this.emitStatus(state.routeId, { status: 'working', label: 'OpenCode is working…' });

    const parts: Array<Record<string, unknown>> = [
      { type: 'text', text: payload.assembledMessage },
      ...attachmentParts(payload.attachments),
    ];
    const system = composeProviderSystemText(payload);
    let promptRequest: SdkResult<Record<string, any>>;
    try {
      promptRequest = state.client.session.prompt({
        path: { id: state.providerSessionId },
        query: { directory: state.cwd },
        body: {
          ...(model ? { model } : {}),
          ...(system ? { system } : {}),
          parts,
        },
        throwOnError: true,
      });
    } catch (error) {
      state.busy = false;
      this.emitStatus(state.routeId, { status: null, label: null });
      throw this.normalizeError(error, 'prompt');
    }
    void promptRequest.then((result) => {
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      this.processPromptResult(state, result.data);
      this.completeOnce(state, 'prompt.result');
    }).catch((error) => {
      if (!this.isCurrent(state, generation) || state.cancelled) return;
      this.failOnce(state, this.normalizeError(error, 'prompt'));
    });
  }

  async cancel(sessionId: string): Promise<void> {
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
      this.failOnce(state, providerError(PROVIDER_ERROR_CODES.CANCELLED, 'OpenCode turn cancelled', true));
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
    const timer = state.pendingPermissions.get(requestId);
    if (timer) clearTimeout(timer);
    state.pendingPermissions.delete(requestId);
    try {
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
    for (const timer of state.pendingPermissions.values()) clearTimeout(timer);
    state.pendingPermissions.clear();
    state.abort.abort();
    state.server.close();
    await state.eventLoop.catch(() => {});
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
        this.processMessage(state, event.properties?.info);
        return;
      case 'permission.updated':
        this.processPermission(state, event.properties);
        return;
      case 'session.status': {
        const status = event.properties?.status;
        if (status?.type === 'busy') this.emitStatus(state.routeId, { status: 'working', label: 'OpenCode is working…' });
        else if (status?.type === 'retry') this.emitStatus(state.routeId, { status: 'retrying', label: safeString(status.message) ?? 'OpenCode is retrying…' });
        else if (status?.type === 'idle') this.completeOnce(state, 'session.status');
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

  private processPromptResult(state: OpenCodeSessionState, result: Record<string, any>): void {
    this.processMessage(state, result?.info);
    if (Array.isArray(result?.parts)) {
      for (const part of result.parts) this.processPart(state, part);
    }
  }

  private processMessage(state: OpenCodeSessionState, info: Record<string, any> | undefined): void {
    if (!info || info.role !== 'assistant') return;
    state.currentMessageId = safeString(info.id) ?? state.currentMessageId;
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
  }

  private processPart(state: OpenCodeSessionState, part: Record<string, any> | undefined, delta?: string): void {
    if (!part || safeString(part.sessionID) !== state.providerSessionId) return;
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
  }

  private processPermission(state: OpenCodeSessionState, permission: Record<string, any>): void {
    const id = safeString(permission?.id);
    if (!id) return;
    const pattern = Array.isArray(permission.pattern) ? permission.pattern.join(', ') : safeString(permission.pattern);
    const request: ApprovalRequest = {
      id,
      description: safeString(permission.title) ?? `Allow OpenCode ${safeString(permission.type) ?? 'operation'}${pattern ? `: ${pattern}` : ''}`,
      ...(safeString(permission.type) ? { tool: permission.type } : {}),
      provider: this.id,
      providerGeneration: state.generation,
      ...(safeString(permission.callID) ? { providerToolUseId: permission.callID } : {}),
      ...(pattern ? { inputPreview: pattern.slice(0, 300) } : {}),
    };
    if (this.approvalCallbacks.length === 0) {
      void this.respondApproval(state.routeId, id, false).catch((error) => {
        this.emitError(state.routeId, this.normalizeError(error, 'permission rejection'));
      });
      return;
    }
    const prior = state.pendingPermissions.get(id);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      state.pendingPermissions.delete(id);
      void this.respondApproval(state.routeId, id, false).catch((error) => {
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
    const usage = {
      input_tokens: positiveNumber(tokens.input) ?? 0,
      output_tokens: positiveNumber(tokens.output) ?? 0,
      cache_read_input_tokens: positiveNumber(tokens.cache?.read) ?? 0,
      cache_creation_input_tokens: positiveNumber(tokens.cache?.write) ?? 0,
      ...(modelContextWindow !== undefined ? { model_context_window: modelContextWindow } : {}),
      ...(positiveNumber(cost) !== undefined ? { cost_usd: cost } : {}),
    };
    const signature = JSON.stringify(usage);
    if (signature === state.lastUsageSignature) return;
    state.lastUsageSignature = signature;
    const update: ProviderUsageUpdate = {
      ...(safeString(messageId) ? { messageId: String(messageId) } : {}),
      finalized,
      usage,
      ...(state.model ? { model: state.model } : {}),
    };
    for (const callback of this.usageCallbacks) callback(state.routeId, update);
  }

  private completeOnce(state: OpenCodeSessionState, source: string): void {
    if (!state.busy || state.completionEmitted || state.terminalErrorEmitted || state.cancelled) return;
    state.completionEmitted = true;
    state.busy = false;
    this.emitStatus(state.routeId, { status: null, label: null });
    const content = [...state.textParts.values()].join('');
    const message: AgentMessage = {
      id: state.currentMessageId ?? `${state.providerSessionId}:${state.generation}`,
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
      },
    };
    for (const callback of this.completeCallbacks) callback(state.routeId, message);
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
    return providerError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, `OpenCode ${operation} failed: ${message}`, true);
  }
}
