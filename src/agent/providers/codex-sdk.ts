import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline, { type Interface as ReadlineInterface } from 'node:readline';
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
import { CODEX_SDK_EFFORT_LEVELS, type TransportEffortLevel } from '../../../shared/effort-levels.js';
import { normalizeTransportCwd, resolveExecutableForSpawn } from '../transport-paths.js';

const CODEX_BIN = 'codex';

type JsonRpcResponse = {
  id?: number;
  result?: Record<string, any>;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: Record<string, any>;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

interface CodexSdkSessionState {
  routeId: string;
  cwd: string;
  model?: string;
  effort?: TransportEffortLevel;
  threadId?: string;
  loaded: boolean;
  runningTurnId?: string;
  currentMessageId: string | null;
  currentText: string;
  pendingComplete?: AgentMessage;
  cancelled: boolean;
  lastUsage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  };
}

function toolFromItem(item: Record<string, any>, lifecycle: 'started' | 'completed'): ToolCallEvent | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        id: item.id,
        name: 'Bash',
        status: item.status === 'inProgress' || lifecycle === 'started' ? 'running' : item.status === 'completed' ? 'complete' : 'error',
        input: { command: item.command },
        ...(item.status !== 'inProgress' ? { output: item.aggregatedOutput ?? item.output ?? '' } : {}),
        detail: {
          kind: 'commandExecution',
          summary: item.command,
          input: {
            command: item.command,
            cwd: item.cwd,
            actions: item.commandActions,
          },
          output: item.aggregatedOutput ?? item.output ?? '',
          meta: {
            status: item.status,
            exitCode: item.exitCode,
            durationMs: item.durationMs,
            processId: item.processId,
          },
          raw: item,
        },
      };
    case 'mcpToolCall':
      return {
        id: item.id,
        name: `mcp:${item.server}:${item.tool}`,
        status: item.status === 'inProgress' || lifecycle === 'started' ? 'running' : item.status === 'completed' ? 'complete' : 'error',
        input: item.arguments,
        ...(item.status === 'completed'
          ? { output: JSON.stringify(item.result?.structuredContent ?? item.result?.content ?? '') }
          : item.status === 'failed'
            ? { output: item.error?.message ?? 'failed' }
            : {}),
        detail: {
          kind: 'mcpToolCall',
          summary: `${item.server}:${item.tool}`,
          input: item.arguments,
          output: item.result?.structuredContent ?? item.result?.content ?? item.error?.message,
          meta: {
            server: item.server,
            tool: item.tool,
            status: item.status,
          },
          raw: item,
        },
      };
    case 'fileChange':
      return {
        id: item.id,
        name: 'Patch',
        status: lifecycle === 'started' || item.status === 'inProgress'
          ? 'running'
          : item.status === 'completed'
            ? 'complete'
            : 'error',
        input: { changes: item.changes },
        detail: {
          kind: 'fileChange',
          summary: Array.isArray(item.changes) ? `${item.changes.length} change(s)` : undefined,
          input: { changes: item.changes },
          output: item.output,
          meta: { status: item.status },
          raw: item,
        },
      };
    case 'webSearch':
      return {
        id: item.id,
        name: 'WebSearch',
        status: lifecycle === 'started' ? 'running' : 'complete',
        input: {
          query: item.query,
          ...(item.action ? { action: item.action } : {}),
        },
        detail: {
          kind: 'webSearch',
          summary: item.query,
          input: {
            query: item.query,
            action: item.action,
          },
          meta: { actionType: item.action?.type },
          raw: item,
        },
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
    streaming: true,
    toolCalling: true,
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
    reasoningEffort: true,
    supportedEffortLevels: CODEX_SDK_EFFORT_LEVELS,
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, CodexSdkSessionState>();
  private threadToSession = new Map<string, string>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: ReadlineInterface | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();

  async connect(config: ProviderConfig): Promise<void> {
    const binaryPath = this.resolveBinaryPath(config);
    // Resolve the binary (handles npm .cmd shims on Windows) and verify it.
    const resolved = resolveExecutableForSpawn(binaryPath);
    await access(resolved.executable, fsConstants.X_OK).catch(async () => {
      // Fall back to spawn-based version probe (works for things on PATH).
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        execFile(resolved.executable, [...resolved.prependArgs, '--version'], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
      });
    });
    await this.startAppServer(binaryPath);
    this.config = config;
    logger.info({ provider: this.id, resolved: resolved.executable, prepend: resolved.prependArgs }, 'Codex SDK provider connected via app-server');
  }

  async disconnect(): Promise<void> {
    this.rejectPending(new Error('Codex app-server disconnected'));
    this.rl?.close();
    this.rl = null;
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
    this.child = null;
    this.threadToSession.clear();
    this.sessions.clear();
    this.config = null;
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existing = config.fresh ? undefined : this.sessions.get(routeId);
    this.sessions.set(routeId, {
      routeId,
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      effort: config.effort ?? existing?.effort,
      threadId: config.resumeId ?? existing?.threadId,
      loaded: false,
      runningTurnId: undefined,
      currentMessageId: null,
      currentText: '',
      pendingComplete: undefined,
      cancelled: false,
      lastUsage: undefined,
    });
    if (config.resumeId || config.effort) this.emitSessionInfo(routeId, { ...(config.resumeId ? { resumeId: config.resumeId } : {}), ...(config.effort ? { effort: config.effort } : {}) });
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.threadId && state.loaded) {
      await this.request('thread/unsubscribe', { threadId: state.threadId }).catch(() => {});
      this.threadToSession.delete(state.threadId);
    }
    this.sessions.delete(sessionId);
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

  async send(sessionId: string, message: string): Promise<void> {
    if (!this.config || !this.child) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Codex app-server not connected', false);
    }
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown Codex SDK session: ${sessionId}`, false);
    }
    if (state.runningTurnId) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Codex SDK session is already busy', true);
    }

    state.currentText = '';
    state.currentMessageId = null;
    state.pendingComplete = undefined;
    state.cancelled = false;
    state.lastUsage = undefined;
    await this.startTurn(sessionId, state, message);
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state?.threadId || !state.runningTurnId) return;
    state.cancelled = true;
    await this.request('turn/interrupt', {
      threadId: state.threadId,
      turnId: state.runningTurnId,
    }).catch(() => {});
  }

  private async startAppServer(binaryPath: string): Promise<void> {
    await this.disconnect().catch(() => {});
    // Resolve npm .cmd shims into (node.exe, [scriptPath]) so spawn works
    // without shell:true (which has its own quoting issues on Windows).
    const resolved = resolveExecutableForSpawn(binaryPath);
    const args = [...resolved.prependArgs, 'app-server'];
    const child = spawn(resolved.executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    });
    this.child = child;
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.trim()) logger.debug({ provider: this.id, stderr: text.trim() }, 'Codex app-server stderr');
    });
    child.on('exit', (code) => {
      const err = new Error(`Codex app-server exited with code ${code ?? 'unknown'}`);
      this.rejectPending(err);
      const sessions = [...this.sessions.keys()];
      for (const sid of sessions) {
        this.emitError(sid, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, false));
      }
      this.child = null;
    });
    // CRITICAL: must listen for 'error' or spawn failures (e.g. ENOENT) become
    // uncaughtException and crash the daemon.
    child.on('error', (err) => {
      logger.error({ provider: this.id, err }, 'Codex app-server spawn error');
      this.rejectPending(err);
      const sessions = [...this.sessions.keys()];
      for (const sid of sessions) {
        this.emitError(sid, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, false));
      }
      this.child = null;
    });

    await this.request('initialize', {
      clientInfo: { name: 'imcodes', title: 'IM.codes', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
  }

  private async startTurn(sessionId: string, state: CodexSdkSessionState, message: string): Promise<void> {
    try {
      await this.ensureThreadLoaded(sessionId, state);
      const result = await this.request('turn/start', {
        threadId: state.threadId,
        input: [{ type: 'text', text: message }],
        cwd: state.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        ...(state.model ? { model: state.model } : {}),
        ...(state.effort ? { effort: state.effort } : {}),
      });
      state.runningTurnId = result?.turn?.id;
    } catch (err) {
      state.runningTurnId = undefined;
      this.emitError(sessionId, this.normalizeError(err));
    }
  }

  private async ensureThreadLoaded(sessionId: string, state: CodexSdkSessionState): Promise<void> {
    if (state.threadId && state.loaded) return;
    if (state.threadId) {
      const result = await this.request('thread/resume', {
        threadId: state.threadId,
        ...(state.model ? { model: state.model } : {}),
      });
      const resumedId = result?.thread?.id ?? state.threadId;
      state.threadId = resumedId;
      state.loaded = true;
      this.threadToSession.set(resumedId, sessionId);
      this.emitSessionInfo(sessionId, { resumeId: resumedId, ...(state.model ? { model: state.model } : {}) });
      return;
    }

    const result = await this.request('thread/start', {
      cwd: state.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      personality: 'none',
      ...(state.model ? { model: state.model } : {}),
    });
    const threadId = result?.thread?.id;
    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id');
    }
    state.threadId = threadId;
    state.loaded = true;
    this.threadToSession.set(threadId, sessionId);
    this.emitSessionInfo(sessionId, { resumeId: threadId, ...(state.model ? { model: state.model } : {}) });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      logger.warn({ provider: this.id, line: trimmed, err }, 'Failed to parse Codex app-server line');
      return;
    }

    if (typeof msg.id === 'number') {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? 'Codex app-server request failed'));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (!msg.method) return;
    this.handleNotification(msg.method, msg.params ?? {});
  }

  private handleNotification(method: string, params: Record<string, any>): void {
    if (method === 'thread/started') {
      const threadId = params.thread?.id;
      if (!threadId) return;
      const sessionId = this.threadToSession.get(threadId);
      if (!sessionId) return;
      const state = this.sessions.get(sessionId);
      if (!state) return;
      state.threadId = threadId;
      state.loaded = true;
      this.emitSessionInfo(sessionId, { resumeId: threadId, ...(state.model ? { model: state.model } : {}) });
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
      const sessionId = this.threadToSession.get(params.threadId);
      const state = sessionId ? this.sessions.get(sessionId) : null;
      const last = params.tokenUsage?.last;
      if (!state || !last) return;
      state.lastUsage = {
        input_tokens: Number(last.inputTokens ?? 0),
        cached_input_tokens: Number(last.cachedInputTokens ?? 0),
        output_tokens: Number(last.outputTokens ?? 0),
      };
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const sessionId = this.threadToSession.get(params.threadId);
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;
      state.currentMessageId = params.itemId;
      state.currentText += String(params.delta ?? '');
      const delta: MessageDelta = {
        messageId: params.itemId,
        type: 'text',
        delta: state.currentText,
        role: 'assistant',
      };
      for (const cb of this.deltaCallbacks) cb(sessionId, delta);
      return;
    }

    if (method === 'item/started' || method === 'item/completed') {
      const sessionId = this.threadToSession.get(params.threadId);
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;

      const item = params.item as Record<string, any> | undefined;
      if (!item) return;

      const tool = toolFromItem(item, method === 'item/started' ? 'started' : 'completed');
      if (tool) {
        for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
      }

      if (item.type === 'agentMessage') {
        state.currentMessageId = item.id;
        if (method === 'item/completed' && typeof item.text === 'string') {
          const prior = state.currentText;
          state.currentText = item.text;
          if (!prior && item.text) {
            const delta: MessageDelta = {
              messageId: item.id,
              type: 'text',
              delta: item.text,
              role: 'assistant',
            };
            for (const cb of this.deltaCallbacks) cb(sessionId, delta);
          }
        }
      }
      return;
    }

    if (method === 'turn/completed') {
      const sessionId = this.threadToSession.get(params.threadId);
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;
      const turn = params.turn ?? {};
      const status = turn.status;

      if (status === 'failed') {
        state.runningTurnId = undefined;
        this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, turn.error?.message ?? 'Codex turn failed', false, turn.error));
        return;
      }
      if (status === 'interrupted') {
        state.runningTurnId = undefined;
        this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex turn cancelled', true));
        return;
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
          ...(state.lastUsage ? { usage: state.lastUsage } : {}),
          ...(state.model ? { model: state.model } : {}),
          ...(state.threadId ? { resumeId: state.threadId } : {}),
        },
      };
      state.runningTurnId = undefined;
      const completed = state.pendingComplete;
      state.pendingComplete = undefined;
      if (completed) {
        for (const cb of this.completeCallbacks) cb(sessionId, completed);
      }
      return;
    }
  }

  private request(method: string, params: Record<string, any>): Promise<any> {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server stdin is not writable'));
    }
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.child!.stdin.write(`${payload}\n`);
    });
  }

  private notify(method: string, params: Record<string, any>): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private rejectPending(err: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(err);
    this.pendingRequests.clear();
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private resolveBinaryPath(config: ProviderConfig | null): string {
    return typeof config?.binaryPath === 'string' && config.binaryPath.trim() ? config.binaryPath : CODEX_BIN;
  }

  private normalizeError(err: unknown): ProviderError {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|spawn .*codex/i.test(message)) {
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
