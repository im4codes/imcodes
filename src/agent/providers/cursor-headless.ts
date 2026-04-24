import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderModelList,
  SessionConfig,
  SessionInfoUpdate,
  ProviderStatusUpdate,
  ToolCallEvent,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import logger from '../../util/logger.js';
import {
  normalizeTransportCwd,
  resolveBinaryWithWindowsFallbacks,
  resolveExecutableForSpawn,
  terminateChildProcess,
} from '../transport-paths.js';
import {
  parseCursorStreamLine,
  type CursorParsedEvent,
} from './cursor-headless-stream.js';

const CURSOR_BIN = 'cursor-agent';
const CONNECT_PROBE_TIMEOUT_MS = 15_000;
const CANCEL_ESCALATION_MS = 2_000;
const MIN_CURSOR_VERSION = { major: 1, minor: 0, patch: 0 };

export interface CursorHeadlessRuntimeHooks {
  loadChildProcess(): Promise<typeof import('node:child_process')>;
}

export const cursorHeadlessRuntimeHooks: CursorHeadlessRuntimeHooks = {
  loadChildProcess: async () => import('node:child_process'),
};

interface CursorSessionState {
  routeId: string;
  resumeId: string;
  cwd: string;
  model?: string;
  child: ChildProcess | null;
  currentMessageId: string | null;
  currentText: string;
  pendingFinalText?: string;
  pendingFinalMetadata?: Record<string, unknown>;
  cancelled: boolean;
  completed: boolean;
  emittedToolSignatures: Map<string, string>;
  lastStatusSignature: string | null;
}

function isTruthyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function extractString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isTruthyString(value)) return value.trim();
  }
  return undefined;
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toProcessEnv(value: unknown): NodeJS.ProcessEnv {
  if (!value || typeof value !== 'object') return {};
  return value as NodeJS.ProcessEnv;
}

function extractResultText(event: CursorParsedEvent): string | undefined {
  if (event.kind !== 'result.success') return undefined;
  return event.text;
}

export class CursorHeadlessProvider implements TransportProvider {
  readonly id = 'cursor-headless';
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
    reasoningEffort: false,
    contextSupport: 'degraded-message-side-context-mapping',
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, CursorSessionState>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];

  async connect(config: ProviderConfig): Promise<void> {
    const resolved = resolveExecutableForSpawn(this.resolveBinaryPath(config));
    let versionOutput = '';
    try {
      const versionProbe = await this.runExecFile(resolved.executable, [...resolved.prependArgs, '--version'], {
        windowsHide: true,
        timeout: CONNECT_PROBE_TIMEOUT_MS,
      });
      versionOutput = `${versionProbe.stdout}\n${versionProbe.stderr}`.trim();
    } catch (err) {
      throw this.normalizeConnectError(err, 'Cursor binary not found or not executable');
    }
    const parsedVersion = this.parseCursorVersion(versionOutput);
    if (!parsedVersion) {
      throw this.makeError(
        PROVIDER_ERROR_CODES.CONFIG_ERROR,
        `Unable to parse Cursor version from probe output: ${versionOutput || 'empty output'}`,
        false,
        { output: versionOutput || undefined },
      );
    }
    if (!this.isSupportedCursorVersion(parsedVersion)) {
      throw this.makeError(
        PROVIDER_ERROR_CODES.CONFIG_ERROR,
        `Cursor ${parsedVersion.raw} is below required ${MIN_CURSOR_VERSION.major}.${MIN_CURSOR_VERSION.minor}.${MIN_CURSOR_VERSION.patch}`,
        false,
        {
          actualVersion: parsedVersion.raw,
          minimumVersion: `${MIN_CURSOR_VERSION.major}.${MIN_CURSOR_VERSION.minor}.${MIN_CURSOR_VERSION.patch}`,
        },
      );
    }
    try {
      const { stdout, stderr } = await this.runExecFile(resolved.executable, [...resolved.prependArgs, 'status'], {
        windowsHide: true,
        timeout: CONNECT_PROBE_TIMEOUT_MS,
      });
      const statusText = `${stdout}\n${stderr}`.trim();
      if (/not\s+logged\s+in|sign\s*in|log\s+in|logged\s+out|unauth/i.test(statusText)) {
        throw this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, `Cursor is not authenticated: ${statusText || 'status probe reported unauthenticated'}`, false, statusText);
      }
      if (!/logged\s+in|authenticated|signed\s+in|status:\s*ok/i.test(statusText)) {
        throw this.makeError(
          PROVIDER_ERROR_CODES.CONFIG_ERROR,
          `Unable to determine Cursor authentication state from status probe: ${statusText || 'empty output'}`,
          false,
          statusText || undefined,
        );
      }
    } catch (err) {
      if (this.isAuthProbeFailure(err)) throw this.normalizeAuthError(err);
      throw this.normalizeConnectError(err, 'Cursor status probe failed');
    }
    this.config = config;
    logger.info({ provider: this.id, resolved: resolved.executable }, 'Cursor headless provider connected');
  }

  async disconnect(): Promise<void> {
    for (const state of this.sessions.values()) {
      if (state.child && !state.child.killed) {
        terminateChildProcess(state.child, CANCEL_ESCALATION_MS);
      }
    }
    this.sessions.clear();
    this.config = null;
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existingEntry = this.findSessionByRouteId(routeId);
    if (existingEntry && !config.fresh) {
      const [sessionId, state] = existingEntry;
      if (isTruthyString(config.agentId)) state.model = config.agentId;
      this.emitSessionInfo(sessionId, {
        resumeId: state.resumeId,
        ...(state.model ? { model: state.model } : {}),
      });
      return sessionId;
    }

    if (existingEntry && config.fresh) {
      await this.endSession(existingEntry[0]).catch(() => {});
    }

    const cwd = normalizeTransportCwd(config.cwd) ?? normalizeTransportCwd(process.cwd())!;
    const model = isTruthyString(config.agentId) ? config.agentId : this.resolveDefaultModel();
    const resumeId =
      isTruthyString(config.resumeId)
        ? config.resumeId
        : isTruthyString(config.bindExistingKey)
          ? config.bindExistingKey
          : config.skipCreate
            ? routeId
            : await this.createRemoteChat(config, model);

    const state: CursorSessionState = {
      routeId,
      resumeId,
      cwd,
      model,
      child: null,
      currentMessageId: null,
      currentText: '',
      pendingFinalText: undefined,
      pendingFinalMetadata: undefined,
      cancelled: false,
      completed: false,
      emittedToolSignatures: new Map(),
      lastStatusSignature: null,
    };
    this.sessions.set(routeId, state);
    this.emitSessionInfo(routeId, {
      resumeId,
      ...(model ? { model } : {}),
    });
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const [resolvedId, state] = this.findSessionByAnyId(sessionId) ?? [];
    if (!state) return;
    if (state.child && !state.child.killed) {
      terminateChildProcess(state.child, CANCEL_ESCALATION_MS);
    }
    this.sessions.delete(resolvedId ?? sessionId);
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

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.push(cb);
    return () => {
      const idx = this.statusCallbacks.indexOf(cb);
      if (idx >= 0) this.statusCallbacks.splice(idx, 1);
    };
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.getSessionState(sessionId);
    if (!state) return;
    state.model = agentId;
    this.emitSessionInfo(this.findSessionIdForState(state) ?? sessionId, {
      resumeId: state.resumeId,
      model: agentId,
    });
  }

  async send(sessionId: string, payloadOrMessage: string | ProviderContextPayload, attachments?: TransportAttachment[], extraSystemPrompt?: string): Promise<void> {
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Cursor headless provider not connected', false);
    }
    const state = this.getSessionState(sessionId);
    if (!state) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown Cursor session: ${sessionId}`, false);
    }
    if (state.child && !state.child.killed) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Cursor session is already busy', true);
    }

    state.cancelled = false;
    state.completed = false;
    state.currentMessageId = null;
    state.currentText = '';
    state.pendingFinalText = undefined;
    state.pendingFinalMetadata = undefined;
    state.emittedToolSignatures.clear();
    state.lastStatusSignature = null;

    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    const prompt = this.composePrompt(payload);
    const resolved = resolveExecutableForSpawn(this.resolveBinaryPath(this.config));
    const resumeId = await this.ensureResumeId(state, resolved);
    const args = [
      ...resolved.prependArgs,
      '-p',
      ...(this.getTrustFlag() ? ['--trust'] : []),
      ...(this.getForceFlag() ? ['--force'] : []),
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--resume',
      resumeId,
      ...(state.model ? ['--model', state.model] : []),
      prompt,
    ];
    const { spawn } = await cursorHeadlessRuntimeHooks.loadChildProcess();
    const child = spawn(resolved.executable, args, {
      cwd: state.cwd,
      env: {
        ...process.env,
        ...toProcessEnv(this.config.env),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    state.child = child;

    let completed = false;
    let sawError = false;
    let stderrBuf = '';

    const sessionKey = this.findSessionIdForState(state) ?? sessionId;
    const emitError = (error: ProviderError): void => {
      if (sawError || completed) return;
      sawError = true;
      for (const cb of this.errorCallbacks) cb(sessionKey, error);
    };
    const emitDelta = (text: string): void => {
      const messageId = state.currentMessageId ??= randomUUID();
      state.currentText = text;
      const delta: MessageDelta = {
        messageId,
        type: 'text',
        delta: text,
        role: 'assistant',
      };
      for (const cb of this.deltaCallbacks) cb(sessionKey, delta);
    };
    const emitTool = (tool: ToolCallEvent): void => {
      const signature = JSON.stringify({
        status: tool.status,
        name: tool.name,
        input: tool.input ?? null,
        output: tool.output ?? null,
      });
      if (state.emittedToolSignatures.get(tool.id) === signature) return;
      state.emittedToolSignatures.set(tool.id, signature);
      for (const cb of this.toolCallCallbacks) cb(sessionKey, tool);
    };
    const emitSessionInfoUpdate = (info: SessionInfoUpdate): void => {
      this.emitSessionInfo(sessionKey, info);
    };

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const event = parseCursorStreamLine(line);
      if (!event) return;

      if (event.kind === 'session.init') {
        if (event.sessionId) {
          state.resumeId = event.sessionId;
        }
        if (event.model) {
          state.model = event.model;
        }
        emitSessionInfoUpdate({
          resumeId: state.resumeId,
          ...(state.model ? { model: state.model } : {}),
        });
        return;
      }

      if (event.kind === 'assistant.delta') {
        const chunk = event.text;
        if (chunk) {
          const nextText = chunk.startsWith(state.currentText)
            ? chunk
            : state.currentText + chunk;
          if (nextText !== state.currentText) {
            emitDelta(nextText);
          }
        }
        if (event.messageId) {
          state.currentMessageId = event.messageId;
        }
        return;
      }

      if (event.kind === 'assistant.final') {
        if (event.messageId) {
          state.currentMessageId = event.messageId;
        }
        state.pendingFinalText = event.text;
        return;
      }

      if (event.kind === 'tool.started') {
        emitTool({
          id: event.id,
          name: event.name,
          status: 'running',
          ...(event.input !== undefined ? { input: event.input } : {}),
          detail: {
            kind: 'tool_call.started',
            summary: event.name,
            input: event.input,
            raw: event.raw,
          },
        });
        return;
      }

      if (event.kind === 'tool.completed') {
        emitTool({
          id: event.id,
          name: event.name,
          status: 'complete',
          ...(event.input !== undefined ? { input: event.input } : {}),
          ...(event.output !== undefined ? { output: stringifyUnknown(event.output) } : {}),
          detail: {
            kind: 'tool_call.completed',
            summary: event.name,
            input: event.input,
            output: event.output,
            raw: event.raw,
          },
        });
        return;
      }

      if (event.kind === 'result.success') {
        const finalText = extractResultText(event) ?? state.pendingFinalText ?? state.currentText;
        completed = true;
        state.completed = true;
        state.child = null;
        state.currentMessageId ??= randomUUID();
        const message: AgentMessage = {
          id: state.currentMessageId,
          sessionId: sessionKey,
          kind: 'text',
          role: 'assistant',
          content: finalText ?? '',
          timestamp: Date.now(),
          status: 'complete',
          metadata: {
            ...(event.model ? { model: event.model } : {}),
            ...(event.usage ? { usage: event.usage } : {}),
            ...(state.resumeId ? { resumeId: state.resumeId } : {}),
          },
        };
        for (const cb of this.completeCallbacks) cb(sessionKey, message);
        return;
      }

      if (event.kind === 'result.error') {
        state.completed = true;
        completed = false;
        state.child = null;
        emitError(this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, event.message, false, event.raw));
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBuf += chunk.toString();
      logger.debug({ provider: this.id, stderr: chunk.toString().trim() }, 'Cursor headless stderr');
    });

    child.once('close', (code, signal) => {
      rl.close();
      state.child = null;
      if (completed || sawError) return;
      if (state.cancelled) {
        emitError(this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Cursor turn cancelled', true, { code, signal }));
        return;
      }
      const text = state.pendingFinalText ?? state.currentText;
      if (typeof code === 'number' && code === 0 && text) {
        completed = true;
        state.completed = true;
        const finalMessage: AgentMessage = {
          id: state.currentMessageId ?? randomUUID(),
          sessionId: sessionKey,
          kind: 'text',
          role: 'assistant',
          content: text,
          timestamp: Date.now(),
          status: 'complete',
          metadata: {
            ...(state.resumeId ? { resumeId: state.resumeId } : {}),
            ...(state.model ? { model: state.model } : {}),
          },
        };
        for (const cb of this.completeCallbacks) cb(sessionKey, finalMessage);
        return;
      }
      emitError(this.makeError(
        signal || code === 0 ? PROVIDER_ERROR_CODES.PROVIDER_ERROR : PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        stderrBuf.trim() || `Cursor exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`,
        false,
        { code, signal, stderr: stderrBuf.trim() || undefined },
      ));
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (err) => reject(this.normalizeConnectError(err, 'Cursor child process failed to start')));
    });
    child.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      emitError(this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, message, false, err));
    });
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    return !!this.getSessionState(sessionId);
  }

  async listModels(force?: boolean): Promise<ProviderModelList> {
    try {
      const { getCursorRuntimeConfig } = await import('../cursor-runtime-config.js');
      const cfg = await getCursorRuntimeConfig(force ?? false);
      return {
        models: cfg.availableModels.map((id) => ({ id })),
        ...(cfg.defaultModel ? { defaultModel: cfg.defaultModel } : {}),
        isAuthenticated: cfg.isAuthenticated,
      };
    } catch (err) {
      return { models: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.getSessionState(sessionId);
    if (!state?.child || state.child.killed) return;
    state.cancelled = true;
    terminateChildProcess(state.child, CANCEL_ESCALATION_MS);
  }

  private resolveBinaryPath(config: ProviderConfig | null): string {
    const explicit = isTruthyString(config?.binaryPath) ? config.binaryPath.trim() : undefined;
    if (explicit) return explicit;
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA;
      const windowsCandidates = localAppData
        ? [
            path.join(localAppData, 'cursor-agent', 'cursor-agent.exe'),
            path.join(localAppData, 'cursor-agent', 'agent.exe'),
          ]
        : [];
      return resolveBinaryWithWindowsFallbacks(CURSOR_BIN, windowsCandidates);
    }
    return CURSOR_BIN;
  }

  private resolveDefaultModel(): string | undefined {
    return isTruthyString(this.config?.agentId) ? this.config!.agentId : undefined;
  }

  private parseCursorVersion(output: string): { major: number; minor: number; patch: number; raw: string } | null {
    const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      raw: `${match[1]}.${match[2]}.${match[3]}`,
    };
  }

  private isSupportedCursorVersion(version: { major: number; minor: number; patch: number }): boolean {
    if (version.major !== MIN_CURSOR_VERSION.major) return version.major > MIN_CURSOR_VERSION.major;
    if (version.minor !== MIN_CURSOR_VERSION.minor) return version.minor > MIN_CURSOR_VERSION.minor;
    return version.patch >= MIN_CURSOR_VERSION.patch;
  }

  private getTrustFlag(): boolean {
    return this.config?.trust !== false;
  }

  private getForceFlag(): boolean {
    return this.config?.force !== false;
  }

  private composePrompt(payload: ProviderContextPayload): string {
    const parts = [payload.systemText?.trim(), payload.assembledMessage?.trim()].filter((part): part is string => !!part && part.length > 0);
    return parts.join('\n\n');
  }

  private async createRemoteChat(config: SessionConfig, model?: string): Promise<string> {
    const resolved = resolveExecutableForSpawn(this.resolveBinaryPath(this.config));
    const { stdout, stderr } = await this.runExecFile(resolved.executable, [...resolved.prependArgs, 'create-chat'], {
      windowsHide: true,
      timeout: CONNECT_PROBE_TIMEOUT_MS,
      env: {
        ...process.env,
        ...toProcessEnv(this.config?.env),
      },
      cwd: normalizeTransportCwd(config.cwd) ?? normalizeTransportCwd(process.cwd())!,
    });
    const chatId = this.extractChatId(stdout, stderr);
    if (!chatId) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Cursor create-chat did not return a chat id', false, { stdout, stderr, model });
    }
    return chatId;
  }

  private extractChatId(stdout: string, stderr: string): string | undefined {
    const candidates = [stdout, stderr];
    for (const chunk of candidates) {
      if (!chunk) continue;
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          const sessionId = extractString(record, 'session_id', 'sessionId', 'chat_id', 'chatId', 'id');
          if (sessionId) return sessionId;
          if (record.result && typeof record.result === 'object' && !Array.isArray(record.result)) {
            const result = record.result as Record<string, unknown>;
            const nested = extractString(result, 'session_id', 'sessionId', 'chat_id', 'chatId', 'id');
            if (nested) return nested;
          }
        }
      } catch {
        // fall back to plain text parsing
      }
      const match = trimmed.match(/[A-Za-z0-9][A-Za-z0-9._:-]{6,}/);
      if (match) return match[0];
    }
    return undefined;
  }

  private findSessionByRouteId(routeId: string): [string, CursorSessionState] | undefined {
    for (const entry of this.sessions.entries()) {
      if (entry[1].routeId === routeId) return entry;
    }
    return undefined;
  }

  private findSessionByAnyId(sessionId: string): [string, CursorSessionState] | undefined {
    const direct = this.sessions.get(sessionId);
    if (direct) return [sessionId, direct];
    const byResumeId = [...this.sessions.entries()].find((entry) => entry[1].resumeId === sessionId);
    if (byResumeId) return byResumeId;
    return this.findSessionByRouteId(sessionId);
  }

  private getSessionState(sessionId: string): CursorSessionState | undefined {
    return this.findSessionByAnyId(sessionId)?.[1];
  }

  private findSessionIdForState(state: CursorSessionState): string | undefined {
    for (const [sessionId, candidate] of this.sessions.entries()) {
      if (candidate === state) return sessionId;
    }
    return undefined;
  }

  private async ensureResumeId(state: CursorSessionState, resolved: { executable: string; prependArgs: string[] }): Promise<string> {
    if (isTruthyString(state.resumeId)) return state.resumeId;
    const { stdout, stderr } = await this.runExecFile(resolved.executable, [...resolved.prependArgs, 'create-chat'], {
      windowsHide: true,
      timeout: CONNECT_PROBE_TIMEOUT_MS,
      env: {
        ...process.env,
        ...toProcessEnv(this.config?.env),
      },
      cwd: state.cwd,
    });
    const chatId = this.extractChatId(stdout, stderr);
    if (!chatId) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Cursor create-chat did not return a chat id', false, { stdout, stderr });
    }
    state.resumeId = chatId;
    this.emitSessionInfo(this.findSessionIdForState(state) ?? state.routeId, {
      resumeId: chatId,
      ...(state.model ? { model: state.model } : {}),
    });
    return chatId;
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private async runExecFile(
    executable: string,
    args: string[],
    options: {
      windowsHide?: boolean;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
      cwd?: string;
    },
  ): Promise<{ stdout: string; stderr: string }> {
    const { execFile } = await cursorHeadlessRuntimeHooks.loadChildProcess();
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(executable, args, options, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
        });
      });
    });
  }

  private normalizeConnectError(err: unknown, fallbackMessage: string): ProviderError {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|spawn .*cursor-agent/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND, `Cursor binary not found: ${message}`, false, err);
    }
    if (/not\s+logged\s+in|sign\s*in|log\s+in|unauth/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, `Cursor authentication failed: ${message}`, false, err);
    }
    return this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR, `${fallbackMessage}: ${message}`, false, err);
  }

  private normalizeAuthError(err: unknown): ProviderError {
    const message = err instanceof Error ? err.message : String(err);
    return this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, `Cursor authentication failed: ${message}`, false, err);
  }

  private isAuthProbeFailure(err: unknown): boolean {
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code?: unknown }).code;
      if (code === PROVIDER_ERROR_CODES.AUTH_FAILED) return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    return /not\s+logged\s+in|sign\s*in|log\s+in|logged\s+out|unauth/i.test(message);
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, ...(details !== undefined ? { details } : {}) };
  }
}
