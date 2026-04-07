import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { query, type PermissionMode, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  SessionConfig,
  SessionInfoUpdate,
  ToolCallEvent,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import logger from '../../util/logger.js';
import { CLAUDE_SDK_EFFORT_LEVELS, type TransportEffortLevel } from '../../../shared/effort-levels.js';
import { normalizeTransportCwd, resolveExecutableForSpawn } from '../transport-paths.js';

const CLAUDE_BIN = 'claude';
const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions';

interface ClaudeSdkSessionState {
  routeId: string;
  cwd: string;
  env?: Record<string, string>;
  model?: string;
  description?: string;
  permissionMode: PermissionMode;
  effort?: TransportEffortLevel;
  started: boolean;
  resumeId: string;
  currentMessageId: string | null;
  currentText: string;
  currentQuery: ReturnType<typeof query> | null;
  completed: boolean;
  cancelled: boolean;
  finalMetadata?: Record<string, unknown>;
  pendingComplete?: AgentMessage;
  toolCalls: Map<number, ToolCallEvent & { partialInputJson?: string }>;
  emittedToolStates: Map<string, string>;
}

type ClaudeToolBlock = {
  type: 'tool_use' | 'server_tool_use' | 'mcp_tool_use';
  id?: string;
  name?: string;
  input?: unknown;
};

function collectAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant' || !Array.isArray(message.message.content)) return '';
  return message.message.content
    .map((block) => {
      if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') return '';
      return block.text;
    })
    .filter(Boolean)
    .join('');
}

function makeMessageId(state: ClaudeSdkSessionState): string {
  return state.currentMessageId ?? `${state.resumeId}:${randomUUID()}`;
}

export class ClaudeCodeSdkProvider implements TransportProvider {
  readonly id = 'claude-code-sdk';
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
    supportedEffortLevels: CLAUDE_SDK_EFFORT_LEVELS,
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, ClaudeSdkSessionState>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];

  async connect(config: ProviderConfig): Promise<void> {
    const binaryPath = this.resolveBinaryPath(config);
    const resolved = resolveExecutableForSpawn(binaryPath);
    await access(resolved.executable, fsConstants.X_OK).catch(async () => {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        execFile(resolved.executable, [...resolved.prependArgs, '--version'], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
      });
    });
    this.config = config;
    logger.info({ provider: this.id, resolved: resolved.executable }, 'Claude Code SDK provider connected');
  }

  async disconnect(): Promise<void> {
    for (const state of this.sessions.values()) {
      try { state.currentQuery?.close(); } catch {}
    }
    this.sessions.clear();
    this.config = null;
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existing = config.fresh ? undefined : this.sessions.get(routeId);
    const resumeId = config.resumeId ?? existing?.resumeId ?? routeId;
    this.sessions.set(routeId, {
      routeId,
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      env: config.env ?? existing?.env,
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      description: config.description ?? existing?.description,
      permissionMode: this.resolvePermissionMode(),
      effort: config.effort ?? existing?.effort,
      started: !!(config.resumeId && config.skipCreate),
      resumeId,
      currentMessageId: existing?.currentMessageId ?? null,
      currentText: existing?.currentText ?? '',
      currentQuery: null,
      completed: false,
      cancelled: false,
      finalMetadata: existing?.finalMetadata,
      pendingComplete: undefined,
      toolCalls: new Map(),
      emittedToolStates: new Map(),
    });
    this.emitSessionInfo(routeId, { resumeId, ...(config.effort ? { effort: config.effort } : {}) });
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state) {
      try { state.currentQuery?.close(); } catch {}
      this.sessions.delete(sessionId);
    }
  }

  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaCallbacks.push(cb);
    return () => {
      const idx = this.deltaCallbacks.indexOf(cb);
      if (idx >= 0) this.deltaCallbacks.splice(idx, 1);
    };
  }

  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeCallbacks.push(cb);
    return () => {
      const idx = this.completeCallbacks.indexOf(cb);
      if (idx >= 0) this.completeCallbacks.splice(idx, 1);
    };
  }

  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorCallbacks.push(cb);
    return () => {
      const idx = this.errorCallbacks.indexOf(cb);
      if (idx >= 0) this.errorCallbacks.splice(idx, 1);
    };
  }

  onToolCall(cb: (sessionId: string, tool: ToolCallEvent) => void): void {
    this.toolCallCallbacks.push(cb);
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.sessionInfoCallbacks.push(cb);
    return () => {
      const idx = this.sessionInfoCallbacks.indexOf(cb);
      if (idx >= 0) this.sessionInfoCallbacks.splice(idx, 1);
    };
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.model = agentId;
  }

  setSessionEffort(sessionId: string, effort: TransportEffortLevel): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.effort = effort;
    this.emitSessionInfo(sessionId, { effort });
  }

  async send(sessionId: string, message: string, _attachments?: unknown[], extraSystemPrompt?: string): Promise<void> {
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Claude Code SDK provider not connected', false);
    }
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown Claude SDK session: ${sessionId}`, false);
    }
    if (state.currentQuery) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Claude SDK session is already busy', true);
    }

    state.currentText = '';
    state.currentMessageId = null;
    state.completed = false;
    state.cancelled = false;
    state.finalMetadata = undefined;
    state.pendingComplete = undefined;
    state.toolCalls.clear();
    state.emittedToolStates.clear();

    const resolvedBinary = this.resolveBinaryPath(this.config);
    const options: Record<string, unknown> = {
      cwd: state.cwd,
      ...(state.env ? { env: { ...process.env, ...state.env } } : {}),
      permissionMode: state.permissionMode,
      pathToClaudeCodeExecutable: resolvedBinary,
      includePartialMessages: true,
      ...(state.started ? { resume: state.resumeId } : { sessionId: state.resumeId }),
      ...(state.model ? { model: state.model } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
      ...(extraSystemPrompt ? { appendSystemPrompt: extraSystemPrompt } : {}),
    };
    // On Windows where claude resolved to a .cmd shim, override the SDK's
    // internal spawn so we can prepend `node script.js` and avoid spawn
    // EINVAL on .cmd files.
    if (this.windowsSpawnOverride) {
      const override = this.windowsSpawnOverride;
      options.spawnClaudeCodeProcess = (req: { command: string; args: string[]; cwd?: string; env?: Record<string, string>; signal?: AbortSignal }) => {
        const finalArgs = [...override.prependArgs, ...req.args];
        const child = spawn(override.executable, finalArgs, {
          cwd: req.cwd,
          env: req.env,
          signal: req.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        // CRITICAL: always listen for 'error' so spawn failures don't bubble
        // up to uncaughtException and crash the daemon. The SDK will also
        // observe the error via the child's exit/stderr, but if it doesn't
        // we still need to swallow it here.
        child.on('error', (err) => {
          logger.error({ provider: this.id, err }, 'Claude SDK spawn error (suppressed)');
        });
        return child;
      };
    }

    const q = query({ prompt: message, options: options as any });
    state.currentQuery = q;
    void this.consumeQuery(sessionId, state, q);
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state?.currentQuery) return;
    state.cancelled = true;
    try {
      await state.currentQuery.interrupt();
    } catch {}
    try {
      state.currentQuery.close();
    } catch {}
  }

  private async consumeQuery(sessionId: string, state: ClaudeSdkSessionState, q: ReturnType<typeof query>): Promise<void> {
    let pendingError: ProviderError | null = null;
    try {
      for await (const msg of q) {
        this.handleMessage(sessionId, state, msg);
      }
      if (!state.completed && state.cancelled) {
        pendingError = this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Claude turn cancelled', true);
      }
    } catch (err) {
      pendingError = state.cancelled
        ? this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Claude turn cancelled', true, err)
        : this.normalizeError(err);
    } finally {
      state.currentQuery = null;
      const pendingComplete = state.pendingComplete;
      state.pendingComplete = undefined;
      state.currentMessageId = null;
      state.currentText = '';
      if (pendingComplete) {
        for (const cb of this.completeCallbacks) cb(sessionId, pendingComplete);
      } else if (pendingError) {
        this.emitError(sessionId, pendingError);
      }
    }
  }

  private handleMessage(sessionId: string, state: ClaudeSdkSessionState, msg: SDKMessage): void {
    if ('session_id' in msg && typeof msg.session_id === 'string' && msg.session_id) {
      state.resumeId = msg.session_id;
      this.emitSessionInfo(sessionId, {
        resumeId: msg.session_id,
        ...(state.model ? { model: state.model } : {}),
      });
    }

    if (msg.type === 'system' && msg.subtype === 'init') {
      state.model = msg.model;
      state.started = true;
      this.emitSessionInfo(sessionId, { resumeId: msg.session_id, model: msg.model });
      return;
    }

    if (msg.type === 'stream_event') {
      const event = msg.event;
      if (event.type === 'message_start' && event.message?.id) {
        state.currentMessageId = String(event.message.id);
        return;
      }
      if (event.type === 'content_block_start' && this.isToolBlock(event.content_block)) {
        const tool = this.normalizeToolCall(event.content_block);
        state.toolCalls.set(event.index, { ...tool, partialInputJson: undefined });
        this.emitToolCall(sessionId, state, tool);
        return;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        state.currentText += event.delta.text;
        const messageId = makeMessageId(state);
        state.currentMessageId = messageId;
        const delta: MessageDelta = {
          messageId,
          type: 'text',
          delta: state.currentText,
          role: 'assistant',
        };
        for (const cb of this.deltaCallbacks) cb(sessionId, delta);
        return;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
        const tool = state.toolCalls.get(event.index);
        if (!tool) return;
        tool.partialInputJson = (tool.partialInputJson ?? '') + event.delta.partial_json;
        const parsed = this.tryParsePartialJson(tool.partialInputJson);
        if (parsed !== undefined) tool.input = parsed;
        return;
      }
      if (event.type === 'content_block_stop') {
        const tool = state.toolCalls.get(event.index);
        if (!tool) return;
        if (tool.partialInputJson && tool.input === undefined) {
          const parsed = this.tryParsePartialJson(tool.partialInputJson);
          if (parsed !== undefined) tool.input = parsed;
        }
        this.emitToolCall(sessionId, state, {
          id: tool.id,
          name: tool.name,
          status: 'complete',
          ...(tool.input !== undefined ? { input: tool.input } : {}),
          detail: {
            kind: 'tool_use_complete',
            summary: tool.name,
            input: tool.input,
            raw: tool,
          },
        });
        state.toolCalls.delete(event.index);
      }
      return;
    }

    if (msg.type === 'assistant') {
      const text = collectAssistantText(msg);
      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (this.isToolBlock(block)) {
            this.emitToolCall(sessionId, state, this.normalizeToolCall(block));
          }
        }
      }
      if (text) {
        if (text !== state.currentText) {
          const messageId = makeMessageId(state);
          state.currentMessageId = messageId;
          state.currentText = text;
          const delta: MessageDelta = {
            messageId,
            type: 'text',
            delta: text,
            role: 'assistant',
          };
          for (const cb of this.deltaCallbacks) cb(sessionId, delta);
        } else {
          state.currentText = text;
        }
      } else {
        state.currentText = text;
      }
      return;
    }

    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const output = Array.isArray(block.content)
          ? block.content
            .map((entry) => {
              if (!entry || typeof entry !== 'object') return '';
              if ('text' in entry && typeof (entry as { text?: unknown }).text === 'string') {
                return (entry as { text: string }).text;
              }
              return '';
            })
            .filter(Boolean)
            .join('\n')
          : typeof block.content === 'string'
            ? block.content
            : undefined;
        this.emitToolCall(sessionId, state, {
          id: block.tool_use_id,
          name: 'tool',
          status: block.is_error ? 'error' : 'complete',
          ...(output ? { output } : {}),
          detail: {
            kind: 'tool_result',
            output,
            raw: block,
          },
        });
      }
      return;
    }

    if (msg.type === 'result') {
      if (msg.is_error) {
        const details = Array.isArray((msg as any).errors) ? (msg as any).errors.join('; ') : 'Claude execution failed';
        this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, details, false, msg));
        return;
      }
      state.started = true;
      state.completed = true;
      const messageId = makeMessageId(state);
      const success = msg as any;
      state.pendingComplete = {
        id: messageId,
        sessionId,
        kind: 'text',
        role: 'assistant',
        content: success.result,
        timestamp: Date.now(),
        status: 'complete',
        metadata: {
          ...(state.model ? { model: state.model } : {}),
          usage: msg.usage,
          resultSubtype: msg.subtype,
          resumeId: state.resumeId,
        },
      };
      return;
    }
  }

  private resolvePermissionMode(): PermissionMode {
    const configured = this.config?.permissionMode;
    if (configured === 'default' || configured === 'acceptEdits' || configured === 'bypassPermissions' || configured === 'plan' || configured === 'dontAsk' || configured === 'auto') {
      return configured;
    }
    return DEFAULT_PERMISSION_MODE;
  }

  private resolveBinaryPath(config: ProviderConfig | null): string {
    const raw = typeof config?.binaryPath === 'string' && config.binaryPath.trim() ? config.binaryPath : CLAUDE_BIN;
    // For windows + .cmd shim, the SDK can't spawn this directly.
    // We pass it to the SDK as a marker, then override spawn via
    // spawnClaudeCodeProcess (see send()).
    if (process.platform === 'win32') {
      const resolved = resolveExecutableForSpawn(raw);
      this.windowsSpawnOverride = resolved.prependArgs.length > 0
        ? { executable: resolved.executable, prependArgs: resolved.prependArgs }
        : null;
      return resolved.executable;
    }
    return raw;
  }
  private windowsSpawnOverride: { executable: string; prependArgs: string[] } | null = null;

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private emitError(sessionId: string, error: ProviderError): void {
    if (this.sessions.get(sessionId)?.completed && error.code === PROVIDER_ERROR_CODES.CANCELLED) return;
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private emitToolCall(sessionId: string, state: ClaudeSdkSessionState, tool: ToolCallEvent): void {
    const signature = JSON.stringify({
      status: tool.status,
      name: tool.name,
      input: tool.input ?? null,
      output: tool.output ?? null,
    });
    if (state.emittedToolStates.get(tool.id) === signature) return;
    state.emittedToolStates.set(tool.id, signature);
    for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
  }

  private isToolBlock(block: unknown): block is ClaudeToolBlock {
    if (!block || typeof block !== 'object') return false;
    const type = (block as { type?: unknown }).type;
    return type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use';
  }

  private normalizeToolCall(block: ClaudeToolBlock): ToolCallEvent {
    const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
    return {
      id: typeof block.id === 'string' && block.id ? block.id : randomUUID(),
      name,
      status: 'running',
      ...(block.input !== undefined ? { input: block.input } : {}),
      detail: {
        kind: block.type,
        summary: name,
        input: block.input,
        raw: block,
      },
    };
  }

  private tryParsePartialJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  private normalizeError(err: unknown): ProviderError {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|spawn .*claude/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND, `Claude binary not found: ${message}`, false, err);
    }
    if (/resume|session/i.test(message) && /not found|invalid|unknown/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, message, true, err);
    }
    return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, message, false, err);
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, ...(details !== undefined ? { details } : {}) };
  }
}
