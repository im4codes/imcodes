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
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import logger from '../../util/logger.js';

const CLAUDE_BIN = 'claude';
const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

interface ClaudeSdkSessionState {
  routeId: string;
  cwd: string;
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
}

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
    toolCalling: false,
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

    const options: Record<string, unknown> = {
      cwd: state.cwd,
      permissionMode: state.permissionMode,
      pathToClaudeCodeExecutable: this.resolveBinaryPath(this.config),
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
      }
      return;
    }

    if (msg.type === 'assistant') {
      const text = collectAssistantText(msg);
      if (text) {
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
