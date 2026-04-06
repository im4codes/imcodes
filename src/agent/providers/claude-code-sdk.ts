import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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

const CLAUDE_BIN = 'claude';
const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions';

interface ClaudeSdkSessionState {
  routeId: string;
  cwd: string;
  env?: Record<string, string>;
  model?: string;
  description?: string;
  permissionMode: PermissionMode;
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
    await access(binaryPath, fsConstants.X_OK).catch(async () => {
      // Fall back to PATH lookup when access(path) fails for bare command names.
      if (binaryPath !== CLAUDE_BIN) throw new Error(binaryPath);
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        execFile(binaryPath, ['--version'], (err) => (err ? reject(err) : resolve()));
      });
    });
    this.config = config;
    logger.info({ provider: this.id }, 'Claude Code SDK provider connected');
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
      cwd: config.cwd ?? existing?.cwd ?? process.cwd(),
      env: config.env ?? existing?.env,
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      description: config.description ?? existing?.description,
      permissionMode: this.resolvePermissionMode(),
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
    });
    this.emitSessionInfo(routeId, { resumeId });
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

    const options: Record<string, unknown> = {
      cwd: state.cwd,
      ...(state.env ? { env: { ...process.env, ...state.env } } : {}),
      permissionMode: state.permissionMode,
      pathToClaudeCodeExecutable: this.resolveBinaryPath(this.config),
      includePartialMessages: true,
      ...(state.started ? { resume: state.resumeId } : { sessionId: state.resumeId }),
      ...(state.model ? { model: state.model } : {}),
      ...(extraSystemPrompt ? { appendSystemPrompt: extraSystemPrompt } : {}),
    };

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
        this.emitToolCall(sessionId, tool);
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
        this.emitToolCall(sessionId, {
          id: tool.id,
          name: tool.name,
          status: 'complete',
          ...(tool.input !== undefined ? { input: tool.input } : {}),
        });
        state.toolCalls.delete(event.index);
      }
      return;
    }

    if (msg.type === 'assistant') {
      const text = collectAssistantText(msg);
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
    return typeof config?.binaryPath === 'string' && config.binaryPath.trim() ? config.binaryPath : CLAUDE_BIN;
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private emitError(sessionId: string, error: ProviderError): void {
    if (this.sessions.get(sessionId)?.completed && error.code === PROVIDER_ERROR_CODES.CANCELLED) return;
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private emitToolCall(sessionId: string, tool: ToolCallEvent): void {
    for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
  }

  private isToolBlock(block: unknown): block is ClaudeToolBlock {
    if (!block || typeof block !== 'object') return false;
    const type = (block as { type?: unknown }).type;
    return type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use';
  }

  private normalizeToolCall(block: ClaudeToolBlock): ToolCallEvent {
    return {
      id: typeof block.id === 'string' && block.id ? block.id : randomUUID(),
      name: typeof block.name === 'string' && block.name ? block.name : 'tool',
      status: 'running',
      ...(block.input !== undefined ? { input: block.input } : {}),
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
