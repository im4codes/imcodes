/**
 * Pi coding-agent transport.
 *
 * Pi's supported RPC mode gives IM.codes an exact process boundary: strict
 * LF-delimited JSONL, durable session ids, token streaming, tool lifecycle,
 * steering, cancellation, model selection, and settled-run notification. One
 * child is retained per IM.codes session so uploads, tools, prompt cache and
 * conversation state all remain warm across turns.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderDelegationNotification,
  ProviderError,
  ProviderModelList,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  SessionConfig,
  SessionInfoUpdate,
  TransportProvider,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
  normalizeProviderPayload,
} from '../transport-provider.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../../shared/agent-message.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import {
  PI_ASSISTANT_EVENT,
  PI_MCP_CONFIG_ENV,
  PI_PROVIDER_API_KEY_ENV,
  PI_PROVIDER_CONFIG_ENV,
  PI_RPC_COMMAND,
  PI_RPC_FRAME,
  isPiRpcResponse,
  type PiLlmConfig,
  type PiRpcCommand,
  type PiRpcResponse,
} from '../../../shared/pi-agent.js';
import {
  PI_EFFORT_LEVELS,
  isTransportEffortLevel,
  type TransportEffortLevel,
} from '../../../shared/effort-levels.js';
import {
  MEMORY_MCP_PROVIDER_ID,
  MEMORY_MCP_STATUS,
  type MemoryMcpProviderStatusView,
} from '../../../shared/memory-ws.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import { composeMessageSideProviderPrompt, getProviderSystemTextParts } from '../provider-context-routing.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import { MCP_TOOL_CATALOG_MODES } from '../../../shared/mcp-tool-discovery.js';
import { normalizeTransportCwd, resolveExecutableForSpawn } from '../transport-paths.js';
import { killProcessTree } from '../../util/kill-process-tree.js';
import {
  buildPiRpcArgs,
  formatPiLaunchError,
  resolvePiBinary,
} from './pi/runtime.js';
import logger from '../../util/logger.js';

const RPC_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 3_000;

interface PendingRpc {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PiSessionState {
  routeId: string;
  piSessionId: string;
  sessionName?: string;
  projectName?: string;
  cwd: string;
  env?: Record<string, string>;
  requestedModel?: string;
  model?: string;
  provider?: string;
  effort?: TransportEffortLevel;
  llmConfig?: PiLlmConfig;
  child: ChildProcess | null;
  decoder: StringDecoder;
  outputBuffer: string;
  startPromise: Promise<void> | null;
  pending: Map<string, PendingRpc>;
  currentText: string;
  currentMessageId: string | null;
  committedSegments: string[];
  turnActive: boolean;
  cancelled: boolean;
  terminalError: string | null;
  terminalAborted: boolean;
  lastUsage?: ProviderUsageUpdate['usage'];
  sessionSystemTextInjected?: string;
  pendingSessionSystemText?: string;
  toolNames: Map<string, string>;
  lastStatusSignature: string | null;
  disposed: boolean;
  memoryMcp?: { command: string; args: readonly string[]; env: Record<string, string> };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      const block = asRecord(item);
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

function stringifyToolResult(value: unknown): string | undefined {
  const record = asRecord(value);
  const text = extractTextContent(record?.content);
  if (text) return text;
  if (value === undefined) return undefined;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function modelInfo(value: unknown): { id?: string; name?: string; provider?: string } {
  const model = asRecord(value);
  return {
    id: typeof model?.id === 'string' ? model.id : undefined,
    name: typeof model?.name === 'string' ? model.name : undefined,
    provider: typeof model?.provider === 'string' ? model.provider : undefined,
  };
}

export class PiProvider implements TransportProvider {
  readonly id = MEMORY_MCP_PROVIDER_ID.PI;
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
    reasoningEffort: true,
    supportedEffortLevels: PI_EFFORT_LEVELS,
    contextSupport: 'degraded-message-side-context-mapping',
    activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, PiSessionState>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  private infoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private usageCallbacks: Array<(sessionId: string, update: ProviderUsageUpdate) => void> = [];

  async connect(config: ProviderConfig): Promise<void> {
    this.config = config;
    logger.info({ provider: this.id, binary: resolvePiBinary() }, 'Pi provider connected');
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.endSession(id)));
    this.config = null;
    logger.info({ provider: this.id }, 'Pi provider disconnected');
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const previous = this.sessions.get(routeId);
    if (previous) await this.stopChild(previous);
    const existing = config.fresh ? undefined : previous;
    const requestedModel = config.agentId?.trim() || existing?.requestedModel;
    const effort = config.effort ?? existing?.effort;
    const piSessionId = config.fresh
      ? randomUUID()
      : (config.resumeId?.trim() || existing?.piSessionId || randomUUID());
    const state: PiSessionState = {
      routeId,
      piSessionId,
      sessionName: config.sessionName ?? existing?.sessionName,
      projectName: config.projectName ?? existing?.projectName,
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      env: config.env ?? existing?.env,
      ...(requestedModel ? { requestedModel } : {}),
      ...(effort ? { effort } : {}),
      llmConfig: config.piLlm,
      child: null,
      decoder: new StringDecoder('utf8'),
      outputBuffer: '',
      startPromise: null,
      pending: new Map(),
      currentText: '',
      currentMessageId: null,
      committedSegments: [],
      turnActive: false,
      cancelled: false,
      terminalError: null,
      terminalAborted: false,
      sessionSystemTextInjected: existing?.sessionSystemTextInjected,
      toolNames: new Map(),
      lastStatusSignature: null,
      disposed: false,
      memoryMcp: this.buildMemoryMcp(config),
    };
    this.sessions.set(routeId, state);
    this.emitInfo(routeId, {
      resumeId: piSessionId,
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(effort ? { effort } : {}),
    });
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.disposed = true;
    await this.stopChild(state);
    this.sessions.delete(sessionId);
  }

  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaCallbacks.push(cb);
    return () => { this.deltaCallbacks = this.deltaCallbacks.filter((entry) => entry !== cb); };
  }

  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeCallbacks.push(cb);
    return () => { this.completeCallbacks = this.completeCallbacks.filter((entry) => entry !== cb); };
  }

  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorCallbacks.push(cb);
    return () => { this.errorCallbacks = this.errorCallbacks.filter((entry) => entry !== cb); };
  }

  onToolCall(cb: (sessionId: string, tool: ToolCallEvent) => void): void {
    this.toolCallbacks.push(cb);
  }

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.push(cb);
    return () => { this.statusCallbacks = this.statusCallbacks.filter((entry) => entry !== cb); };
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.infoCallbacks.push(cb);
    return () => { this.infoCallbacks = this.infoCallbacks.filter((entry) => entry !== cb); };
  }

  onUsage(cb: (sessionId: string, update: ProviderUsageUpdate) => void): () => void {
    this.usageCallbacks.push(cb);
    return () => { this.usageCallbacks = this.usageCallbacks.filter((entry) => entry !== cb); };
  }

  async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown session ${sessionId}`, false);
    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    const sessionSystemText = getProviderSystemTextParts(payload).sessionSystemText;
    const includeSessionSystemText = !!sessionSystemText && state.sessionSystemTextInjected !== sessionSystemText;
    const message = composeMessageSideProviderPrompt(payload, { includeSessionSystemText });
    if (!message.trim()) return;

    this.emitStatus(sessionId, state, { status: 'working', label: null });
    await this.ensureChild(state);
    this.resetTurn(state);
    state.currentMessageId = `${state.routeId}:${randomUUID()}`;
    state.turnActive = true;
    state.cancelled = false;
    state.pendingSessionSystemText = includeSessionSystemText ? sessionSystemText : undefined;
    try {
      await this.request(state, { type: PI_RPC_COMMAND.PROMPT, message });
    } catch (error) {
      state.turnActive = false;
      this.clearStatus(sessionId, state);
      this.resetTurn(state);
      throw this.makeError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }

  async notifyActiveDelegation(
    sessionId: string,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    const state = this.sessions.get(sessionId);
    if (!state?.turnActive || state.cancelled || !state.child) {
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    }
    try {
      await this.request(state, { type: PI_RPC_COMMAND.STEER, message: notification.text });
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED;
    } catch {
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state?.child) return;
    state.cancelled = true;
    await this.request(state, { type: PI_RPC_COMMAND.ABORT }).catch(() => {});
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    const model = agentId.trim();
    if (!state || !model || state.requestedModel === model) return;
    state.requestedModel = model;
    const child = state.child;
    this.detachChild(state);
    void this.stopChild(state, child);
  }

  setSessionEffort(sessionId: string, effort: TransportEffortLevel): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.effort === effort) return;
    state.effort = effort;
    if (state.child && !state.turnActive) {
      void this.request(state, { type: PI_RPC_COMMAND.SET_THINKING_LEVEL, level: effort })
        .then(() => this.emitInfo(sessionId, { effort }))
        .catch(() => {});
    }
  }

  async listModels(): Promise<ProviderModelList> {
    return { models: [] };
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    return {
      providerId: this.id,
      status: this.config ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: Boolean(this.config),
      degradedReasons: [],
    };
  }

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      provider: this.id,
      binary: resolvePiBinary(),
      cwd: state.cwd,
      model: state.model,
      piSessionId: state.piSessionId,
      childRunning: !!state.child,
      turnActive: state.turnActive,
      memoryMcpMounted: !!state.memoryMcp,
    };
  }

  private buildMemoryMcp(config: SessionConfig): PiSessionState['memoryMcp'] {
    const server = getDefaultMcpServers(config, {
      // Pi owns the complete paginated refresh + generation proof and can
      // therefore consume standard tools/list_changed without stale schemas.
      toolCatalogMode: MCP_TOOL_CATALOG_MODES.DYNAMIC,
    })[IMCODES_MEMORY_MCP_SERVER_NAME];
    return server ? { command: server.command, args: server.args, env: server.env } : undefined;
  }

  private async ensureChild(state: PiSessionState): Promise<void> {
    if (state.child && state.startPromise) {
      await state.startPromise;
      return;
    }
    const executable = resolveExecutableForSpawn(resolvePiBinary());
    const child = spawn(
      executable.executable,
      [...executable.prependArgs, ...buildPiRpcArgs({
        sessionId: state.piSessionId,
        sessionName: state.sessionName,
        requestedModel: state.requestedModel,
        effort: state.effort,
        llm: state.llmConfig,
      })],
      {
        cwd: state.cwd,
        env: {
          ...process.env,
          ...(state.env ?? {}),
          ...(state.llmConfig ? { [PI_PROVIDER_CONFIG_ENV]: JSON.stringify(state.llmConfig) } : {}),
          ...(state.llmConfig?.apiKey ? { [PI_PROVIDER_API_KEY_ENV]: state.llmConfig.apiKey } : {}),
          ...(state.memoryMcp ? { [PI_MCP_CONFIG_ENV]: JSON.stringify(state.memoryMcp) } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    state.child = child;
    state.decoder = new StringDecoder('utf8');
    state.outputBuffer = '';
    child.stdin?.on('error', (error) => {
      logger.debug({ provider: this.id, session: state.sessionName, error }, 'Pi stdin error');
    });
    child.stdout?.on('data', (chunk: Buffer) => this.handleChunk(state, chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) logger.debug({ provider: this.id, session: state.sessionName, line: line.slice(0, 500) }, 'Pi stderr');
    });
    child.on('error', (error) => this.handleGone(state, child, formatPiLaunchError(error)));
    child.on('exit', (code, signal) => this.handleGone(state, child, `Pi exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`));
    child.on('close', (code, signal) => this.handleGone(state, child, `Pi closed (code=${code ?? 'null'} signal=${signal ?? 'null'})`));

    const startPromise = this.request(state, { type: PI_RPC_COMMAND.GET_STATE })
      .then((response) => this.applyStateResponse(state, response.data))
      .catch((error) => {
        if (state.child === child) this.detachChild(state);
        void killProcessTree(child).catch(() => {});
        throw error;
      });
    state.startPromise = startPromise;
    await startPromise;
  }

  private async stopChild(state: PiSessionState, explicit?: ChildProcess | null): Promise<void> {
    const child = explicit ?? state.child;
    if (!child) return;
    if (state.child === child) this.detachChild(state);
    await killProcessTree(child, { gracefulMs: SHUTDOWN_GRACE_MS }).catch(() => {});
  }

  private detachChild(state: PiSessionState): void {
    state.child = null;
    state.startPromise = null;
    const error = new Error('Pi RPC process disconnected');
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    state.pending.clear();
  }

  private handleGone(state: PiSessionState, child: ChildProcess, message: string): void {
    if (state.child !== child) return;
    const wasActive = state.turnActive;
    this.detachChild(state);
    if (state.disposed || !wasActive) return;
    state.turnActive = false;
    this.clearStatus(state.routeId, state);
    this.resetTurn(state);
    this.emitError(state.routeId, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, message, true));
  }

  private request(state: PiSessionState, command: PiRpcCommand): Promise<PiRpcResponse> {
    const stdin = state.child?.stdin;
    if (!stdin || stdin.destroyed) return Promise.reject(new Error('Pi RPC process is unavailable'));
    const id = command.id ?? randomUUID();
    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`Pi RPC ${command.type} timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      state.pending.set(id, { resolve, reject, timer });
      try {
        stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      } catch (error) {
        clearTimeout(timer);
        state.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Strict LF-only decoder: Pi permits U+2028/U+2029 inside JSON strings. */
  private handleChunk(state: PiSessionState, chunk: Buffer): void {
    state.outputBuffer += state.decoder.write(chunk);
    while (true) {
      const index = state.outputBuffer.indexOf('\n');
      if (index < 0) break;
      let line = state.outputBuffer.slice(0, index);
      state.outputBuffer = state.outputBuffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.handleLine(state, line);
    }
  }

  private handleLine(state: PiSessionState, line: string): void {
    if (!line.trim()) return;
    let frame: unknown;
    try { frame = JSON.parse(line); } catch {
      logger.debug({ provider: this.id, line: line.slice(0, 500) }, 'Pi non-protocol stdout');
      return;
    }
    if (isPiRpcResponse(frame)) {
      const pending = frame.id ? state.pending.get(frame.id) : undefined;
      if (!pending) return;
      clearTimeout(pending.timer);
      state.pending.delete(frame.id!);
      if (frame.success) pending.resolve(frame);
      else pending.reject(new Error(frame.error || `Pi RPC ${frame.command} failed`));
      return;
    }
    const event = asRecord(frame);
    if (event) this.dispatch(state, event);
  }

  private dispatch(state: PiSessionState, event: Record<string, unknown>): void {
    const sessionId = state.routeId;
    switch (event.type) {
      case PI_RPC_FRAME.AGENT_START:
        state.turnActive = true;
        this.emitStatus(sessionId, state, { status: 'working', label: null });
        return;
      case PI_RPC_FRAME.MESSAGE_UPDATE: {
        const update = asRecord(event.assistantMessageEvent);
        if (update?.type === PI_ASSISTANT_EVENT.TEXT_DELTA && typeof update.delta === 'string') {
          state.currentText += update.delta;
          const messageId = state.currentMessageId ?? `${state.routeId}:${randomUUID()}`;
          state.currentMessageId = messageId;
          for (const cb of this.deltaCallbacks) {
            cb(sessionId, { messageId, type: 'text', delta: state.currentText, role: 'assistant' });
          }
        } else if (update?.type === PI_ASSISTANT_EVENT.THINKING_DELTA) {
          this.emitStatus(sessionId, state, { status: 'thinking', label: 'Thinking...' });
        }
        this.captureUsage(state, event.usage);
        return;
      }
      case PI_RPC_FRAME.MESSAGE_END:
        this.captureMessageEnd(state, event.message);
        return;
      case PI_RPC_FRAME.TOOL_EXECUTION_START: {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : randomUUID();
        const name = typeof event.toolName === 'string' ? event.toolName : 'tool';
        state.toolNames.set(id, name);
        this.emitTool(sessionId, { id, name, status: 'running', input: event.args });
        return;
      }
      case PI_RPC_FRAME.TOOL_EXECUTION_UPDATE: {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : randomUUID();
        const name = typeof event.toolName === 'string' ? event.toolName : (state.toolNames.get(id) ?? 'tool');
        this.emitTool(sessionId, {
          id,
          name,
          status: 'running',
          input: event.args,
          output: stringifyToolResult(event.partialResult),
        });
        return;
      }
      case PI_RPC_FRAME.TOOL_EXECUTION_END: {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : randomUUID();
        const name = typeof event.toolName === 'string' ? event.toolName : (state.toolNames.get(id) ?? 'tool');
        this.emitTool(sessionId, {
          id,
          name,
          status: event.isError === true ? 'error' : 'complete',
          output: stringifyToolResult(event.result),
        });
        return;
      }
      case PI_RPC_FRAME.COMPACTION_START:
        this.emitStatus(sessionId, state, { status: 'working', label: 'Compacting...' });
        return;
      case PI_RPC_FRAME.AUTO_RETRY_START:
        this.emitStatus(sessionId, state, { status: 'working', label: 'Retrying...' });
        return;
      case PI_RPC_FRAME.AGENT_SETTLED:
        this.finishTurn(state);
        return;
      default:
        return;
    }
  }

  private captureMessageEnd(state: PiSessionState, value: unknown): void {
    const message = asRecord(value);
    if (message?.role !== 'assistant') return;
    const text = extractTextContent(message.content);
    if (text) state.committedSegments.push(text);
    const info = modelInfo(message);
    // Pi assistant messages carry `model` as the model id string, whereas
    // get_state returns the full model object. Accept both authoritative shapes
    // so usage/final metadata follows provider switches made by Pi itself.
    const messageModel = typeof message.model === 'string' ? message.model : info.id;
    if (messageModel) state.model = messageModel;
    if (info.provider) state.provider = info.provider;
    this.captureUsage(state, message.usage);
    if (message.stopReason === 'error') state.terminalError = typeof message.errorMessage === 'string' ? message.errorMessage : 'Pi turn failed';
    if (message.stopReason === 'aborted') state.terminalAborted = true;
  }

  private captureUsage(state: PiSessionState, value: unknown): void {
    const usage = asRecord(value);
    if (!usage) return;
    const normalized = {
      ...(numeric(usage.input) !== undefined ? { input_tokens: numeric(usage.input) } : {}),
      ...(numeric(usage.output) !== undefined ? { output_tokens: numeric(usage.output) } : {}),
      ...(numeric(usage.cacheRead) !== undefined ? { cache_read_input_tokens: numeric(usage.cacheRead) } : {}),
      ...(numeric(usage.cacheWrite) !== undefined ? { cache_creation_input_tokens: numeric(usage.cacheWrite) } : {}),
    };
    if (Object.keys(normalized).length === 0) return;
    state.lastUsage = normalized;
    for (const cb of this.usageCallbacks) {
      cb(state.routeId, {
        usage: normalized,
        ...(state.model ? { model: state.model } : {}),
        ...(state.currentMessageId ? { messageId: state.currentMessageId } : {}),
      });
    }
  }

  private finishTurn(state: PiSessionState): void {
    if (!state.turnActive) return;
    state.turnActive = false;
    this.clearStatus(state.routeId, state);
    if (state.terminalError || state.terminalAborted || state.cancelled) {
      const cancelled = state.terminalAborted || state.cancelled;
      const message = state.terminalError || (cancelled ? 'Turn cancelled' : 'Pi turn failed');
      this.resetTurn(state);
      this.emitError(state.routeId, this.makeError(
        cancelled ? PROVIDER_ERROR_CODES.CANCELLED : PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        message,
        true,
      ));
      return;
    }
    if (state.pendingSessionSystemText) state.sessionSystemTextInjected = state.pendingSessionSystemText;
    const content = state.committedSegments.length > 0 ? state.committedSegments.join('') : state.currentText;
    const completion: AgentMessage = {
      id: state.currentMessageId ?? `${state.routeId}:${randomUUID()}`,
      sessionId: state.routeId,
      kind: 'text',
      role: 'assistant',
      content,
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        ...(state.model ? { model: state.model } : {}),
        ...(state.lastUsage ? { usage: state.lastUsage } : {}),
      },
    };
    this.resetTurn(state);
    for (const cb of this.completeCallbacks) cb(state.routeId, completion);
  }

  private applyStateResponse(state: PiSessionState, value: unknown): void {
    const data = asRecord(value);
    const model = modelInfo(data?.model);
    if (model.id) state.model = model.id;
    if (model.provider) state.provider = model.provider;
    const effort = data?.thinkingLevel;
    if (isTransportEffortLevel(effort)) state.effort = effort;
    this.emitInfo(state.routeId, {
      resumeId: typeof data?.sessionId === 'string' ? data.sessionId : state.piSessionId,
      ...(model.id ? { model: model.id } : {}),
      ...(isTransportEffortLevel(effort) ? { effort } : {}),
    });
  }

  private resetTurn(state: PiSessionState): void {
    state.currentText = '';
    state.currentMessageId = null;
    state.committedSegments = [];
    state.cancelled = false;
    state.terminalError = null;
    state.terminalAborted = false;
    state.lastUsage = undefined;
    state.pendingSessionSystemText = undefined;
    state.toolNames.clear();
  }

  private emitTool(sessionId: string, tool: ToolCallEvent): void {
    for (const cb of this.toolCallbacks) cb(sessionId, tool);
  }

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private emitInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.infoCallbacks) cb(sessionId, info);
  }

  private emitStatus(sessionId: string, state: PiSessionState, status: ProviderStatusUpdate): void {
    const signature = JSON.stringify({ status: status.status, label: status.label ?? null });
    if (state.lastStatusSignature === signature) return;
    state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }

  private clearStatus(sessionId: string, state: PiSessionState): void {
    this.emitStatus(sessionId, state, { status: null, label: null });
  }

  private makeError(code: string, message: string, recoverable: boolean): ProviderError {
    return { code, message, recoverable };
  }
}
