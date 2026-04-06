import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
} from '@openai/codex-sdk';
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
import type { AgentMessage } from '../../../shared/agent-message.js';
import logger from '../../util/logger.js';

const CODEX_BIN = 'codex';

interface CodexSdkSessionState {
  routeId: string;
  cwd: string;
  model?: string;
  threadId?: string;
  thread: Thread | null;
  runningAbort?: AbortController;
  currentMessageId: string | null;
  currentText: string;
  pendingComplete?: AgentMessage;
}

function toolFromThreadItem(item: ThreadItem): ToolCallEvent | null {
  switch (item.type) {
    case 'command_execution':
      return {
        id: item.id,
        name: 'Bash',
        status: item.status === 'in_progress' ? 'running' : item.status === 'completed' ? 'complete' : 'error',
        input: { command: item.command },
        ...(item.status !== 'in_progress' ? { output: item.aggregated_output } : {}),
      };
    case 'mcp_tool_call':
      return {
        id: item.id,
        name: `mcp:${item.server}:${item.tool}`,
        status: item.status === 'in_progress' ? 'running' : item.status === 'completed' ? 'complete' : 'error',
        input: item.arguments,
        ...(item.status === 'completed'
          ? { output: JSON.stringify(item.result?.structured_content ?? item.result?.content ?? '') }
          : item.status === 'failed'
            ? { output: item.error?.message ?? 'failed' }
            : {}),
      };
    case 'file_change':
      return {
        id: item.id,
        name: 'Patch',
        status: item.status === 'completed' ? 'complete' : 'error',
        input: { changes: item.changes },
      };
    default:
      return null;
  }
}

export class CodexSdkProvider implements TransportProvider {
  readonly id = 'codex-sdk';
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    toolCalling: true,
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, CodexSdkSessionState>();
  private deltaCallbacks: Array<(sessionId: string, delta: never) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];

  async connect(config: ProviderConfig): Promise<void> {
    const binaryPath = this.resolveBinaryPath(config);
    await access(binaryPath, fsConstants.X_OK).catch(async () => {
      if (binaryPath !== CODEX_BIN) throw new Error(binaryPath);
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        execFile(binaryPath, ['--version'], (err) => (err ? reject(err) : resolve()));
      });
    });
    this.config = config;
    logger.info({ provider: this.id }, 'Codex SDK provider connected');
  }

  async disconnect(): Promise<void> {
    for (const state of this.sessions.values()) {
      state.runningAbort?.abort();
    }
    this.sessions.clear();
    this.config = null;
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existing = this.sessions.get(routeId);
    this.sessions.set(routeId, {
      routeId,
      cwd: config.cwd ?? existing?.cwd ?? process.cwd(),
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      threadId: config.resumeId ?? existing?.threadId,
      thread: null,
      runningAbort: undefined,
      currentMessageId: null,
      currentText: '',
      pendingComplete: undefined,
    });
    if (config.resumeId) this.emitSessionInfo(routeId, { resumeId: config.resumeId });
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.runningAbort?.abort();
    this.sessions.delete(sessionId);
  }

  onDelta(cb: (sessionId: string, delta: never) => void): () => void {
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

  async send(sessionId: string, message: string): Promise<void> {
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Codex SDK provider not connected', false);
    }
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown Codex SDK session: ${sessionId}`, false);
    }
    if (state.runningAbort) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Codex SDK session is already busy', true);
    }

    const abort = new AbortController();
    state.runningAbort = abort;
    state.currentText = '';
    state.currentMessageId = null;
    state.pendingComplete = undefined;

    const thread = this.getThread(state);
    state.thread = thread;
    void this.consumeThread(sessionId, state, thread, message, abort);
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    state?.runningAbort?.abort();
  }

  private getThread(state: CodexSdkSessionState): Thread {
    if (state.thread) return state.thread;
    const options: ThreadOptions = {
      workingDirectory: state.cwd,
      skipGitRepoCheck: true,
      ...(state.model ? { model: state.model } : {}),
    };
    const client = new Codex({ codexPathOverride: this.resolveBinaryPath(this.config) });
    state.thread = state.threadId ? client.resumeThread(state.threadId, options) : client.startThread(options);
    return state.thread;
  }

  private async consumeThread(sessionId: string, state: CodexSdkSessionState, thread: Thread, message: string, abort: AbortController): Promise<void> {
    let usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number } | null = null;
    let pendingError: ProviderError | null = null;
    try {
      const { events } = await thread.runStreamed(message, { signal: abort.signal });
      for await (const event of events) {
        this.handleEvent(sessionId, state, event);
        if (event.type === 'turn.completed') usage = event.usage;
      }

      state.pendingComplete = {
        id: state.currentMessageId ?? `${sessionId}:agent-message`,
        sessionId,
        kind: 'text',
        role: 'assistant',
        content: state.currentText,
        timestamp: Date.now(),
        status: 'complete',
        metadata: {
          ...(usage ? { usage } : {}),
          ...(state.model ? { model: state.model } : {}),
          ...(state.threadId ? { resumeId: state.threadId } : {}),
        },
      };
    } catch (err) {
      const aborted = abort.signal.aborted;
      pendingError = aborted ? this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex turn cancelled', true, err) : this.normalizeError(err);
    } finally {
      state.runningAbort = undefined;
      const pendingComplete = state.pendingComplete;
      state.pendingComplete = undefined;
      if (pendingComplete) {
        for (const cb of this.completeCallbacks) cb(sessionId, pendingComplete);
      } else if (pendingError) {
        for (const cb of this.errorCallbacks) cb(sessionId, pendingError);
      }
    }
  }

  private handleEvent(sessionId: string, state: CodexSdkSessionState, event: ThreadEvent): void {
    if (event.type === 'thread.started') {
      state.threadId = event.thread_id;
      this.emitSessionInfo(sessionId, { resumeId: event.thread_id, ...(state.model ? { model: state.model } : {}) });
      return;
    }
    if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      const tool = toolFromThreadItem(event.item);
      if (tool) {
        for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
      }
      if (event.type === 'item.completed' && event.item.type === 'agent_message') {
        state.currentMessageId = event.item.id;
        state.currentText = event.item.text;
      }
      return;
    }
    if (event.type === 'turn.failed') {
      throw new Error(event.error.message);
    }
    if (event.type === 'error') {
      throw new Error(event.message);
    }
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private resolveBinaryPath(config: ProviderConfig | null): string {
    return typeof config?.binaryPath === 'string' && config.binaryPath.trim() ? config.binaryPath : CODEX_BIN;
  }

  private normalizeError(err: unknown): ProviderError {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|Unable to locate Codex CLI binaries/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND, `Codex binary not found: ${message}`, false, err);
    }
    if (/resume|thread/i.test(message) && /not found|invalid|unknown/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, message, true, err);
    }
    return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, message, false, err);
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, ...(details !== undefined ? { details } : {}) };
  }
}
