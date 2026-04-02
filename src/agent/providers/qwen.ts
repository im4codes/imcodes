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
  child: ChildProcess | null;
  currentMessageId: string | null;
  currentText: string;
}

interface QwenStreamEvent {
  type: string;
  index?: number;
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
  is_error?: boolean;
  error?: { message?: string };
  result?: string;
  event?: QwenStreamEvent;
  message?: {
    id?: string;
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

export class QwenProvider implements TransportProvider {
  readonly id = 'qwen';
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
  private sessions = new Map<string, QwenSessionState>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];

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
      child: existing?.child ?? null,
      currentMessageId: existing?.currentMessageId ?? null,
      currentText: existing?.currentText ?? '',
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

  async send(sessionId: string, message: string, _attachments?: unknown[], extraSystemPrompt?: string): Promise<void> {
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Qwen provider not connected', false);
    }

    const state = this.sessions.get(sessionId) ?? {
      cwd: process.cwd(),
      started: true,
      description: undefined,
      child: null,
      currentMessageId: null,
      currentText: '',
    };
    if (state.child && !state.child.killed) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Qwen session is already busy', true);
    }

    state.currentMessageId = null;
    state.currentText = '';

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

    const emitComplete = (text: string, messageId?: string): void => {
      if (completed || sawError) return;
      completed = true;
      state.started = true;
      state.currentMessageId = null;
      state.currentText = '';
      const finalMessageId = messageId || randomUUID();
      const msg: AgentMessage = {
        id: finalMessageId,
        sessionId,
        kind: 'text',
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
        status: 'complete',
      };
      this.completeCallbacks.forEach((cb) => cb(sessionId, msg));
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
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          state.currentMessageId ??= randomUUID();
          state.currentText += event.delta.text;
          this.deltaCallbacks.forEach((cb) => cb(sessionId, {
            messageId: state.currentMessageId!,
            type: 'text',
            delta: state.currentText,
            role: 'assistant',
          }));
        }
        return;
      }

      if (payload.type === 'assistant') {
        const finalText = collectAssistantText(payload.message?.content);
        if (finalText) {
          emitComplete(finalText, payload.message?.id ?? state.currentMessageId ?? undefined);
        }
        return;
      }

      if (payload.type === 'result') {
        if (payload.is_error) {
          emitError(payload.error?.message || stderrBuf || 'Qwen execution failed', payload);
          return;
        }
        if (!completed && typeof payload.result === 'string' && payload.result.trim()) {
          emitComplete(payload.result, state.currentMessageId ?? undefined);
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
