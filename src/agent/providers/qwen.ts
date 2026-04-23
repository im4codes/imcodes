import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { killProcessTree } from '../../util/kill-process-tree.js';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderStatusUpdate,
  SessionConfig,
  ToolCallEvent,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
  type SessionInfoUpdate,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { DEFAULT_TRANSPORT_EFFORT, QWEN_EFFORT_LEVELS, type TransportEffortLevel } from '../../../shared/effort-levels.js';
import logger from '../../util/logger.js';
import { inferContextWindow } from '../../util/model-context.js';
import { normalizeTransportCwd, resolveExecutableForSpawn } from '../transport-paths.js';

const execFileAsync = promisify(execFile);
const QWEN_BIN = 'qwen';
const TRANSIENT_RETRY_DELAY_MS = 250;
const TRANSIENT_RETRY_MAX_ATTEMPTS = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Auth types accepted by the qwen CLI's `--auth-type` flag.
 * Verified via `qwen --help` (qwen 0.14.5). Passing this flag forces the CLI
 * to use the named tier for the current run, bypassing the user-level
 * `~/.qwen/settings.json` that otherwise wins over our system-level settings.
 *
 * This is separate from `shared/qwen-auth.ts`'s display-tier constants
 * (`qwen-oauth` / `coding-plan` / `api-key` — used for UI badges).
 */
const QWEN_CLI_AUTH_TYPES = new Set([
  'openai',
  'anthropic',
  'qwen-oauth',
  'gemini',
  'vertex-ai',
]);

/** Extract `security.auth.selectedType` from a settings object if it names a
 *  qwen CLI auth type. Returns undefined when settings are absent, malformed,
 *  or hold a value that qwen doesn't recognize (so we don't crash the spawn). */
function resolveCliAuthType(settings: string | Record<string, unknown> | undefined): string | undefined {
  if (!settings || typeof settings === 'string') return undefined;
  const security = settings.security;
  if (!security || typeof security !== 'object') return undefined;
  const auth = (security as Record<string, unknown>).auth;
  if (!auth || typeof auth !== 'object') return undefined;
  const selected = (auth as Record<string, unknown>).selectedType;
  if (typeof selected !== 'string') return undefined;
  return QWEN_CLI_AUTH_TYPES.has(selected) ? selected : undefined;
}

function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function extractSyntheticApiError(text: string | undefined): string | undefined {
  if (typeof text !== 'string') return undefined;
  const match = text.trim().match(/^\[API Error:\s*(.+)\]$/i);
  return match?.[1]?.trim() || undefined;
}

interface QwenSessionState {
  cwd: string;
  started: boolean;
  description?: string;
  model?: string;
  env?: Record<string, string>;
  effort: TransportEffortLevel;
  settings?: string | Record<string, unknown>;
  settingsDir?: string;
  settingsPath?: string;
  /** Internal Qwen CLI conversation ID — decoupled from provider session ID so cancel can start fresh. */
  qwenConversationId: string;
  child: ChildProcess | null;
  currentMessageId: string | null;
  currentText: string;
  pendingFinalText?: string;
  pendingFinalMetadata?: Record<string, unknown>;
  cancelled?: boolean;
  toolUseByIndex: Map<number, { id: string; name: string; input?: unknown; partialJson: string }>;
  toolUseById: Map<string, { id: string; name: string; input?: unknown; partialJson: string }>;
  emittedToolSignatures: Map<string, string>;
  lastStatusSignature: string | null;
}

function toQwenReasoning(effort: TransportEffortLevel): false | { effort: 'low' | 'medium' | 'high' } {
  if (effort === 'off') return false;
  if (effort === 'high') return { effort: 'high' };
  if (effort === 'low') return { effort: 'low' };
  return { effort: 'medium' };
}

interface QwenStreamEvent {
  type: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  message?: {
    id?: string;
  };
}

type QwenAssistantContentBlock =
  | { type?: 'text'; text?: string }
  | { type?: 'thinking'; thinking?: string }
  | { type?: 'tool_use'; name?: string; input?: unknown; id?: string }
  | { type?: 'tool_result'; tool_use_id?: string; content?: string | Array<{ type?: string; text?: string }>; is_error?: boolean };

interface QwenStreamMessage {
  type: string;
  session_id?: string;
  subtype?: string;
  model?: string;
  is_error?: boolean;
  error?: { message?: string };
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    total_tokens?: number;
  };
  event?: QwenStreamEvent;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      total_tokens?: number;
    };
    content?: QwenAssistantContentBlock[];
  };
}

type QwenUsage = NonNullable<QwenStreamMessage['usage']>;

function collectAssistantText(content?: QwenAssistantContentBlock[]): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

function stringifyToolResultContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((item) => (item && typeof item === 'object' && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function hasMeaningfulToolValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulToolValue(item));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => hasMeaningfulToolValue(item));
  }
  return false;
}

function sanitizeUsageForDisplay(usage: QwenUsage | undefined, model?: string): QwenUsage | undefined {
  if (!usage) return undefined;
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const cache = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
  const inferredCtx = inferContextWindow(model);
  if (input === undefined) return usage;
  // Qwen stream-json `result.usage` is computed from session metrics and may be
  // cumulative across the whole conversation. That is not a valid context-bar
  // numerator. When it is obviously beyond the model window, treat it as
  // unusable for ctx display and reset the bar instead of showing nonsense like
  // 11M / 1M.
  if (inferredCtx && input + cache > inferredCtx * 2) {
    return {
      input_tokens: 0,
      output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      cache_read_input_tokens: 0,
    };
  }
  return usage;
}

export class QwenProvider implements TransportProvider {
  readonly id = 'qwen';
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
    supportedEffortLevels: QWEN_EFFORT_LEVELS,
    contextSupport: 'degraded-message-side-context-mapping',
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, QwenSessionState>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];

  async connect(config: ProviderConfig): Promise<void> {
    const resolved = resolveExecutableForSpawn(QWEN_BIN);
    await execFileAsync(resolved.executable, [...resolved.prependArgs, '--version'], { windowsHide: true });
    this.config = config;
    logger.info({ provider: this.id, resolved: resolved.executable }, 'Qwen provider connected');
  }

  async disconnect(): Promise<void> {
    for (const [sessionId, state] of this.sessions) {
      if (state.child && !state.child.killed) {
        // Tree-kill: qwen CLI forks children (web_search etc.) that survive
        // a wrapper-only SIGTERM. See killProcessTree for walk+SIGKILL logic.
        void killProcessTree(state.child);
      }
      await this.cleanupSessionSettings(state);
      this.sessions.delete(sessionId);
    }
    this.config = null;
    logger.info({ provider: this.id }, 'Qwen provider disconnected');
  }

  async createSession(config: SessionConfig): Promise<string> {
    const sessionId = config.bindExistingKey ?? config.sessionKey;
    const existing = this.sessions.get(sessionId);
    const qwenConversationId = existing?.qwenConversationId
      ?? (isUuid(config.resumeId) ? config.resumeId : undefined)
      ?? (isUuid(config.bindExistingKey) ? config.bindExistingKey : undefined)
      ?? (isUuid(config.sessionKey) ? config.sessionKey : undefined)
      ?? randomUUID();
    this.sessions.set(sessionId, {
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      started: !!(config.resumeId || config.bindExistingKey || config.skipCreate || existing?.started),
      description: config.description ?? existing?.description,
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      env: config.env ?? existing?.env,
      effort: config.effort ?? existing?.effort ?? DEFAULT_TRANSPORT_EFFORT,
      settings: config.settings ?? existing?.settings,
      settingsDir: existing?.settingsDir,
      settingsPath: existing?.settingsPath,
      qwenConversationId,
      child: existing?.child ?? null,
      currentMessageId: existing?.currentMessageId ?? null,
      currentText: existing?.currentText ?? '',
      pendingFinalText: existing?.pendingFinalText,
      pendingFinalMetadata: existing?.pendingFinalMetadata,
      cancelled: existing?.cancelled ?? false,
      toolUseByIndex: existing?.toolUseByIndex ?? new Map(),
      toolUseById: existing?.toolUseById ?? new Map(),
      emittedToolSignatures: existing?.emittedToolSignatures ?? new Map(),
      lastStatusSignature: existing?.lastStatusSignature ?? null,
    });
    return sessionId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state?.child && !state.child.killed) {
      // Tree-kill so any child forked by the qwen CLI (web_search etc.) is
      // also terminated — see provider disconnect comment.
      void killProcessTree(state.child);
    }
    if (state) await this.cleanupSessionSettings(state);
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

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.push(cb);
    return () => {
      const idx = this.statusCallbacks.indexOf(cb);
      if (idx >= 0) this.statusCallbacks.splice(idx, 1);
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
    this.sessions.set(sessionId, state);
  }

  async setSessionEffort(sessionId: string, effort: TransportEffortLevel): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.effort = effort;
    await this.ensureSettingsPath(state);
  }

  async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    _attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
    allowResumeFallback = true,
    transientRetryBudget = TRANSIENT_RETRY_MAX_ATTEMPTS,
  ): Promise<void> {
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Qwen provider not connected', false);
    }

    const state: QwenSessionState = this.sessions.get(sessionId) ?? {
      cwd: normalizeTransportCwd(process.cwd())!,
      started: true,
      description: undefined,
      model: undefined,
      env: undefined,
      effort: DEFAULT_TRANSPORT_EFFORT,
      settings: undefined,
      settingsDir: undefined,
      settingsPath: undefined,
      qwenConversationId: randomUUID(),
      child: null,
      currentMessageId: null,
      currentText: '',
      pendingFinalText: undefined,
      pendingFinalMetadata: undefined,
      cancelled: false,
      toolUseByIndex: new Map(),
      toolUseById: new Map(),
      emittedToolSignatures: new Map(),
      lastStatusSignature: null,
    };
    if (state.child && !state.child.killed) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Qwen session is already busy', true);
    }

    state.currentMessageId = null;
    state.currentText = '';
    state.pendingFinalText = undefined;
    state.pendingFinalMetadata = undefined;
    state.cancelled = false;
    state.toolUseByIndex.clear();
    state.toolUseById.clear();
    state.emittedToolSignatures.clear();
    state.lastStatusSignature = null;
    const payload = normalizeProviderPayload(payloadOrMessage, _attachments, extraSystemPrompt);

    const args = [
      '-p', payload.assembledMessage,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--approval-mode', 'yolo',
    ];
    const effectivePrompt = payload.systemText?.trim() || state.description?.trim();
    if (effectivePrompt) {
      args.push('--append-system-prompt', effectivePrompt);
    }
    if (state.model) {
      args.push('--model', state.model);
    }
    // When a preset is active, state.settings carries `security.auth.selectedType`.
    // Pass it explicitly via --auth-type so the qwen CLI uses that tier for this
    // run — otherwise user-level ~/.qwen/settings.json (which may still say
    // qwen-oauth) overrides our system-level settings file and we fall back to
    // the discontinued OAuth tier. See shared/qwen-auth.ts for the display-tier
    // counterpart; these CLI values are distinct.
    const cliAuthType = resolveCliAuthType(state.settings);
    if (cliAuthType) {
      args.push('--auth-type', cliAuthType);
    }
    if (state.started) {
      args.push('--resume', state.qwenConversationId);
    } else {
      args.push('--session-id', state.qwenConversationId);
    }

    const resolved = resolveExecutableForSpawn(QWEN_BIN);
    const finalArgs = [...resolved.prependArgs, ...args];
    const child = spawn(resolved.executable, finalArgs, {
      cwd: state.cwd,
      env: {
        ...process.env,
        ...((this.config.env as Record<string, string> | undefined) ?? {}),
        ...(state.env ?? {}),
        QWEN_CODE_SYSTEM_SETTINGS_PATH: await this.ensureSettingsPath(state),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    state.child = child;
    this.sessions.set(sessionId, state);

    let completed = false;
    let sawError = false;
    let stderrBuf = '';
    let retryScheduled = false;

    const sawVisibleTurnProgress = (): boolean => {
      return state.currentText.length > 0
        || !!state.pendingFinalText
        || state.toolUseById.size > 0
        || state.emittedToolSignatures.size > 0;
    };

    const maybeRetryTransientError = async (messageText: string, _details?: unknown): Promise<boolean> => {
      if (retryScheduled || transientRetryBudget <= 0) return false;
      if (sawVisibleTurnProgress()) return false;
      if (!this.isRetryableTransientError(messageText)) return false;
      retryScheduled = true;
      state.child = null;
      logger.info({ provider: this.id, sessionId, message: messageText }, 'Qwen transient provider error; retrying turn once');
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      await this.send(sessionId, payload, _attachments, extraSystemPrompt, allowResumeFallback, transientRetryBudget - 1);
      return true;
    };

    const emitError = (messageText: string, details?: unknown): void => {
      if (sawError || completed) return;
      sawError = true;
      const errorCode = state.cancelled
        ? PROVIDER_ERROR_CODES.CANCELLED
        : (this.isAuthFailureMessage(messageText) ? PROVIDER_ERROR_CODES.AUTH_FAILED : PROVIDER_ERROR_CODES.PROVIDER_ERROR);
      const recoverable = errorCode === PROVIDER_ERROR_CODES.CANCELLED;
      this.errorCallbacks.forEach((cb) => cb(sessionId, this.makeError(errorCode, messageText, recoverable, details)));
    };

    const emitComplete = (text: string, messageId?: string, metadata?: Record<string, unknown>): void => {
      if (completed || sawError) return;
      completed = true;
      state.started = true;
      state.currentMessageId = null;
      state.currentText = '';
      state.pendingFinalText = undefined;
      state.pendingFinalMetadata = undefined;
      const finalMessageId = messageId || randomUUID();
      const msg: AgentMessage = {
        id: finalMessageId,
        sessionId,
        kind: 'text',
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
        status: 'complete',
        ...(metadata ? { metadata } : {}),
      };
      this.completeCallbacks.forEach((cb) => cb(sessionId, msg));
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
      this.toolCallCallbacks.forEach((cb) => cb(sessionId, tool));
    };

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let payload: QwenStreamMessage;
      try {
        payload = JSON.parse(trimmed) as QwenStreamMessage;
      } catch {
        return;
      }

      if (payload.type === 'system' && payload.subtype === 'session_start') {
        state.started = true;
        // Do not overwrite an explicitly selected model with provider-reported
        // backend labels like "coder-model". Keep the requested model as the
        // session truth when available.
        if (!state.model && payload.model) state.model = payload.model;
        if (!state.model && payload.message?.model) state.model = payload.message.model;
        return;
      }

      if (payload.type === 'stream_event') {
        const event = payload.event;
        if (!event) return;
        if (event.type === 'message_start') {
          this.clearStatus(sessionId, state);
          state.currentMessageId = event.message?.id ?? randomUUID();
          state.currentText = '';
          return;
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
          this.emitStatus(sessionId, state, {
            status: 'thinking',
            label: 'Thinking...',
          });
          return;
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          this.clearStatus(sessionId, state);
          const toolId = event.content_block.id ?? randomUUID();
          const toolName = event.content_block.name ?? 'tool';
          const toolInput = event.content_block.input;
          if (typeof event.index === 'number') {
            state.toolUseByIndex.set(event.index, {
              id: toolId,
              name: toolName,
              input: toolInput,
              partialJson: '',
            });
          }
          state.toolUseById.set(toolId, {
            id: toolId,
            name: toolName,
            input: toolInput,
            partialJson: '',
          });
          if (hasMeaningfulToolValue(toolInput)) {
            emitTool({
              id: toolId,
              name: toolName,
              status: 'running',
              input: toolInput,
              detail: {
                kind: 'tool_use',
                summary: toolName,
                input: toolInput,
                raw: event.content_block,
              },
            });
          }
          return;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          this.clearStatus(sessionId, state);
          state.currentMessageId ??= randomUUID();
          state.currentText += event.delta.text;
          this.deltaCallbacks.forEach((cb) => cb(sessionId, {
            messageId: state.currentMessageId!,
            type: 'text',
            delta: state.currentText,
            role: 'assistant',
          }));
          return;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
          this.emitStatus(sessionId, state, {
            status: 'thinking',
            label: 'Thinking...',
          });
          return;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && typeof event.index === 'number') {
          const tool = state.toolUseByIndex.get(event.index);
          if (!tool) return;
          tool.partialJson += event.delta.partial_json ?? '';
          try {
            tool.input = JSON.parse(tool.partialJson);
          } catch {
            // Partial JSON may be incomplete mid-stream.
          }
          state.toolUseById.set(tool.id, tool);
          emitTool({
            id: tool.id,
            name: tool.name,
            status: 'running',
            ...(hasMeaningfulToolValue(tool.input) ? { input: tool.input } : {}),
            detail: {
              kind: 'tool_use',
              summary: tool.name,
              input: tool.input,
              raw: tool,
            },
          });
        }
        return;
      }

      if (payload.type === 'assistant') {
        if ((payload.message?.content ?? []).some((block) => block?.type === 'thinking')) {
          this.emitStatus(sessionId, state, {
            status: 'thinking',
            label: 'Thinking...',
          });
        } else {
          this.clearStatus(sessionId, state);
        }
        for (const block of payload.message?.content ?? []) {
          if (block?.type === 'tool_use' && block.id) {
            if (hasMeaningfulToolValue(block.input)) {
              emitTool({
                id: block.id,
                name: block.name ?? 'tool',
                status: 'running',
                input: block.input,
                detail: {
                  kind: 'tool_use',
                  summary: block.name ?? 'tool',
                  input: block.input,
                  raw: block,
                },
              });
            }
          }
        }
        const finalText = collectAssistantText(payload.message?.content);
        if (finalText) {
          const syntheticApiError = extractSyntheticApiError(finalText);
          if (syntheticApiError) {
            void maybeRetryTransientError(syntheticApiError, payload).then((retried) => {
              if (!retried) emitError(syntheticApiError, payload);
            });
            return;
          }
          state.pendingFinalText = finalText;
          state.pendingFinalMetadata = {
            ...(state.model || payload.message?.model ? { model: state.model ?? payload.message?.model } : {}),
            ...(payload.message?.usage ? { usage: sanitizeUsageForDisplay(payload.message.usage, state.model ?? payload.message?.model) } : {}),
          };
        }
        return;
      }

      if (payload.type === 'user') {
        this.clearStatus(sessionId, state);
        for (const block of payload.message?.content ?? []) {
          if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
          const output = stringifyToolResultContent(block.content);
          const tool = state.toolUseById.get(block.tool_use_id);
          emitTool({
            id: block.tool_use_id,
            name: tool?.name ?? 'tool',
            status: block.is_error ? 'error' : 'complete',
            ...(output ? { output } : {}),
            detail: {
              kind: 'tool_result',
              summary: tool?.name ?? 'tool',
              output,
              raw: block,
            },
          });
        }
        return;
      }

      if (payload.type === 'result') {
        this.clearStatus(sessionId, state);
        if (payload.is_error) {
          const errorText = payload.error?.message || stderrBuf || 'Qwen execution failed';
          void maybeRetryTransientError(errorText, payload).then((retried) => {
            if (!retried) emitError(errorText, payload);
          });
          return;
        }
        const syntheticApiError = extractSyntheticApiError(payload.result);
        if (syntheticApiError) {
          void maybeRetryTransientError(syntheticApiError, payload).then((retried) => {
            if (!retried) emitError(syntheticApiError, payload);
          });
          return;
        }
        const resultText = typeof payload.result === 'string' && payload.result.trim()
          ? payload.result
          : state.pendingFinalText;
        if (!completed && resultText) {
          const assistantUsage = state.pendingFinalMetadata?.usage as QwenUsage | undefined;
          const sanitizedResultUsage = sanitizeUsageForDisplay(payload.usage, state.model);
          state.pendingFinalText = resultText;
          state.pendingFinalMetadata = {
            ...(state.pendingFinalMetadata ?? {}),
            ...(state.model ? { model: state.model } : {}),
            ...(!assistantUsage && sanitizedResultUsage ? { usage: sanitizedResultUsage } : {}),
          };
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrBuf += text;
      logger.debug({ provider: this.id, sessionId, stderr: text.trim() }, 'qwen stderr');
    });

    child.once('close', (code, signal) => {
      rl.close();
      state.child = null;
      if (state.cancelled) {
        emitError('Cancelled');
        return;
      }
      if (!completed && !sawError && (code === 0 || code === null)) {
        if (state.pendingFinalText) {
          emitComplete(state.pendingFinalText, state.currentMessageId ?? undefined, state.pendingFinalMetadata);
          return;
        }
      }
      if (!completed && !sawError && code !== 0) {
        if (allowResumeFallback && state.started && /No saved session found with ID/i.test(stderrBuf)) {
          state.started = false;
          state.qwenConversationId = randomUUID();
          this.emitSessionInfo(sessionId, { resumeId: state.qwenConversationId });
          void this.send(sessionId, payload, _attachments, extraSystemPrompt, false).catch((err) => {
            const providerError = typeof err === 'object' && err && 'code' in err
              ? err as ProviderError
              : this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, String(err), false, err);
            emitError(providerError.message, providerError.details ?? providerError);
          });
          return;
        }
        const errorText = stderrBuf.trim() || `Qwen exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`;
        void maybeRetryTransientError(errorText, { code, signal, stderr: stderrBuf }).then((retried) => {
          if (!retried) emitError(errorText);
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (err) => reject(this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, err.message, false)));
    });
    // Persistent error listener so post-spawn errors don't escalate to
    // uncaughtException and crash the daemon.
    child.on('error', (err) => {
      logger.error({ provider: this.id, err }, 'Qwen child process error');
      void maybeRetryTransientError(err.message, err).then((retried) => {
        if (!retried) emitError(err.message, err);
      });
    });
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId) || !!sessionId;
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state?.child || state.child.killed) return;
    state.cancelled = true;
    const child = state.child;
    // Tree-kill: previously we only SIGTERM+SIGKILL'd the wrapper, which
    // left Qwen CLI's grandchildren (web_search, bash helpers) alive.
    // killProcessTree walks the descendant tree via `ps` and sends SIGTERM
    // → SIGKILL to each pid explicitly (2s grace).
    void killProcessTree(child, { gracefulMs: 2_000 });
    // Reset conversation so next send uses --session-id with a fresh ID
    // instead of --resume on the conversation stuck in a tool-call loop.
    state.started = false;
    state.qwenConversationId = randomUUID();
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, details };
  }

  private isRetryableTransientError(message: string): boolean {
    return /premature close|fetch failed|connection error|socket hang up|econnreset|etimedout|network error/i.test(message);
  }

  private isAuthFailureMessage(message: string): boolean {
    return /invalid access token|token expired|unauthorized|authentication failed|401\b/i.test(message);
  }

  private emitStatus(sessionId: string, state: QwenSessionState, status: ProviderStatusUpdate): void {
    const signature = JSON.stringify({
      status: status.status,
      label: status.label ?? null,
    });
    if (state.lastStatusSignature === signature) return;
    state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private clearStatus(sessionId: string, state: QwenSessionState): void {
    this.emitStatus(sessionId, state, { status: null, label: null });
  }

  private async ensureSettingsPath(state: QwenSessionState): Promise<string> {
    if (!state.settingsDir) {
      state.settingsDir = await mkdtemp(path.join(os.tmpdir(), 'imcodes-qwen-thinking-'));
      state.settingsPath = path.join(state.settingsDir, 'settings.json');
    }
    const base = typeof state.settings === 'string'
      ? {}
      : (state.settings && typeof state.settings === 'object' ? state.settings : {});
    const nextModel = {
      ...(base.model && typeof base.model === 'object' ? base.model as Record<string, unknown> : {}),
      generationConfig: {
        ...(
          base.model
          && typeof base.model === 'object'
          && (base.model as Record<string, unknown>).generationConfig
          && typeof (base.model as Record<string, unknown>).generationConfig === 'object'
            ? (base.model as Record<string, unknown>).generationConfig as Record<string, unknown>
            : {}
        ),
        reasoning: toQwenReasoning(state.effort),
      },
    };
    const next = {
      ...base,
      model: nextModel,
    };
    let current = '';
    if (state.settingsPath) {
      try {
        current = await readFile(state.settingsPath, 'utf8');
      } catch {}
      const serialized = JSON.stringify(next);
      if (current.trim() !== serialized) {
        await writeFile(state.settingsPath, serialized, 'utf8');
      }
    }
    return state.settingsPath!;
  }

  private async cleanupSessionSettings(state: QwenSessionState): Promise<void> {
    if (!state.settingsDir) return;
    const dir = state.settingsDir;
    state.settingsDir = undefined;
    state.settingsPath = undefined;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {}
  }
}
