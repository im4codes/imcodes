import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  SessionConfig,
  ToolCallEvent,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import logger from '../../util/logger.js';

const execFileAsync = promisify(execFile);
const QWEN_BIN = 'qwen';

interface QwenSessionState {
  cwd: string;
  started: boolean;
  description?: string;
  model?: string;
  child: ChildProcess | null;
  currentMessageId: string | null;
  currentText: string;
  pendingFinalText?: string;
  pendingFinalMetadata?: Record<string, unknown>;
  toolUseByIndex: Map<number, { id: string; name: string; input?: unknown; partialJson: string }>;
  toolUseById: Map<string, { id: string; name: string; input?: unknown; partialJson: string }>;
  emittedToolSignatures: Map<string, string>;
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
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, QwenSessionState>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];

  async connect(config: ProviderConfig): Promise<void> {
    await execFileAsync(QWEN_BIN, ['--version']);
    this.config = config;
    logger.info({ provider: this.id }, 'Qwen provider connected');
  }

  async disconnect(): Promise<void> {
    for (const [sessionId, state] of this.sessions) {
      if (state.child && !state.child.killed) {
        state.child.kill('SIGTERM');
      }
      this.sessions.delete(sessionId);
    }
    this.config = null;
    logger.info({ provider: this.id }, 'Qwen provider disconnected');
  }

  async createSession(config: SessionConfig): Promise<string> {
    const sessionId = config.bindExistingKey ?? config.sessionKey;
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      cwd: config.cwd ?? existing?.cwd ?? process.cwd(),
      started: !!(config.bindExistingKey || config.skipCreate || existing?.started),
      description: config.description ?? existing?.description,
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      child: existing?.child ?? null,
      currentMessageId: existing?.currentMessageId ?? null,
      currentText: existing?.currentText ?? '',
      pendingFinalText: existing?.pendingFinalText,
      pendingFinalMetadata: existing?.pendingFinalMetadata,
      toolUseByIndex: existing?.toolUseByIndex ?? new Map(),
      toolUseById: existing?.toolUseById ?? new Map(),
      emittedToolSignatures: existing?.emittedToolSignatures ?? new Map(),
    });
    return sessionId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state?.child && !state.child.killed) {
      state.child.kill('SIGTERM');
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

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.model = agentId;
    this.sessions.set(sessionId, state);
  }

  async send(sessionId: string, message: string, _attachments?: unknown[], extraSystemPrompt?: string): Promise<void> {
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Qwen provider not connected', false);
    }

    const state = this.sessions.get(sessionId) ?? {
      cwd: process.cwd(),
      started: true,
      description: undefined,
      model: undefined,
      child: null,
      currentMessageId: null,
      currentText: '',
      pendingFinalText: undefined,
      pendingFinalMetadata: undefined,
      toolUseByIndex: new Map(),
      toolUseById: new Map(),
      emittedToolSignatures: new Map(),
    };
    if (state.child && !state.child.killed) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Qwen session is already busy', true);
    }

    state.currentMessageId = null;
    state.currentText = '';
    state.pendingFinalText = undefined;
    state.pendingFinalMetadata = undefined;
    state.toolUseByIndex.clear();
    state.toolUseById.clear();
    state.emittedToolSignatures.clear();

    const args = [
      '-p', message,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--approval-mode', 'yolo',
    ];
    const effectivePrompt = extraSystemPrompt?.trim() || state.description?.trim();
    if (effectivePrompt) {
      args.push('--append-system-prompt', effectivePrompt);
    }
    if (state.model) {
      args.push('--model', state.model);
    }
    if (state.started) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', sessionId);
    }

    const child = spawn(QWEN_BIN, args, {
      cwd: state.cwd,
      env: {
        ...process.env,
        ...((this.config.env as Record<string, string> | undefined) ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    state.child = child;
    this.sessions.set(sessionId, state);

    let completed = false;
    let sawError = false;
    let stderrBuf = '';

    const emitError = (messageText: string, details?: unknown): void => {
      if (sawError || completed) return;
      sawError = true;
      this.errorCallbacks.forEach((cb) => cb(sessionId, this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, messageText, false, details)));
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
          state.currentMessageId = event.message?.id ?? randomUUID();
          state.currentText = '';
          return;
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
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
            });
          }
          return;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
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
          });
        }
        return;
      }

      if (payload.type === 'assistant') {
        for (const block of payload.message?.content ?? []) {
          if (block?.type === 'tool_use' && block.id) {
            if (hasMeaningfulToolValue(block.input)) {
              emitTool({
                id: block.id,
                name: block.name ?? 'tool',
                status: 'running',
                input: block.input,
              });
            }
          }
        }
        const finalText = collectAssistantText(payload.message?.content);
        if (finalText) {
          state.pendingFinalText = finalText;
          state.pendingFinalMetadata = {
            ...(state.model || payload.message?.model ? { model: state.model ?? payload.message?.model } : {}),
            ...(payload.message?.usage ? { usage: payload.message.usage } : {}),
          };
        }
        return;
      }

      if (payload.type === 'user') {
        for (const block of payload.message?.content ?? []) {
          if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
          const output = stringifyToolResultContent(block.content);
          const tool = state.toolUseById.get(block.tool_use_id);
          emitTool({
            id: block.tool_use_id,
            name: tool?.name ?? 'tool',
            status: block.is_error ? 'error' : 'complete',
            ...(output ? { output } : {}),
          });
        }
        return;
      }

      if (payload.type === 'result') {
        if (payload.is_error) {
          emitError(payload.error?.message || stderrBuf || 'Qwen execution failed', payload);
          return;
        }
        const resultText = typeof payload.result === 'string' && payload.result.trim()
          ? payload.result
          : state.pendingFinalText;
        if (!completed && resultText) {
          emitComplete(resultText, state.currentMessageId ?? undefined, {
            ...(state.pendingFinalMetadata ?? {}),
            ...(state.model ? { model: state.model } : {}),
            ...(payload.usage ? { usage: payload.usage } : {}),
          });
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
      if (!completed && !sawError && (code === 0 || code === null)) {
        if (state.pendingFinalText) {
          emitComplete(state.pendingFinalText, state.currentMessageId ?? undefined, state.pendingFinalMetadata);
          return;
        }
      }
      if (!completed && !sawError && code !== 0) {
        emitError(stderrBuf.trim() || `Qwen exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`);
      }
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (err) => reject(this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, err.message, false)));
    });
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId) || !!sessionId;
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, details };
  }
}
